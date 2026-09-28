import { PRODUCTS_BY_SKU } from "./catalog";
import { decide } from "./decision";
import { checkBudget, checkEligibility, checkSafety, compareProducts, searchProducts } from "./tools";
import { comparableFits, exhaustedLowRiskQuestion, requiredInformation } from "./clarification";
import type { AgentContext, ModelAudit, PlannerAction, ProductFit, StateField, ToolObservation, UserState } from "./types";

export const MAX_PLANNER_STEPS = 5;
const MIN_FINAL_RESERVE_MS = 22_000;

const progressByAction: Record<PlannerAction["action"], { evidenceNeeded: string; expectedProgress: string }> = {
  search_products: { evidenceNeeded: "当前品类的商品事实", expectedProgress: "取得候选并执行强制资格检查" },
  compare_products: { evidenceNeeded: "已合格候选的事实差异", expectedProgress: "补足取舍证据" },
  ask_user: { evidenceNeeded: "会改变当前决定的必要信息", expectedProgress: "等待用户补充一个字段" },
  finalize: { evidenceNeeded: "当前候选和必要信息缺口", expectedProgress: "进入最终裁决" },
};

export function compilePlannerContext(context: AgentContext) {
  return {
    goal: context.goal,
    userState: { facts: Object.fromEntries(Object.entries(context.userState.facts).map(([field, value]) => [field, value?.value])) },
    hardConstraints: context.hardConstraints,
    softPreferences: context.softPreferences,
    requiredMissingFields: context.requiredMissingFields,
    clarification: context.clarification ? { field: context.clarification.field, askedCount: context.clarification.askedCount } : null,
    rawCandidateSkus: context.rawCandidateSkus,
    productFits: context.productFits.map((fit) => ({ sku: fit.sku, status: fit.status, matches: fit.matches, missing: fit.missing, tradeoffs: fit.tradeoffs })),
    observations: context.observations.map(({ order, tool, outcome }) => ({ order, tool, outcome })).slice(-10),
    allowedActions: context.allowedActions,
    step: context.step,
    remainingTimeBudget: context.remainingTimeBudget,
    versions: context.versions,
  };
}

export function authorizePlannerAction(raw: unknown, context: AgentContext, completed: ReadonlySet<string>): { action: PlannerAction | null; reason: string } {
  if (!raw || typeof raw !== "object") return { action: null, reason: "INVALID_ACTION" };
  const value = raw as Record<string, unknown>;
  if (value.action === "finalize" && context.hardConstraints.safety === "active_risk") return { action: null, reason: "SAFETY_STOP" };
  if (value.action === "finalize" && context.goal.type === "buy_product" && context.goal.categories.some((category) => !completed.has(`search:${category}`))) return { action: null, reason: "EVIDENCE_REQUIRED" };
  if (value.action === "finalize" && context.requiredMissingFields.length) return { action: null, reason: "REQUIRED_FIELD_MISSING" };
  if (value.action === "search_products" && value.arguments && typeof value.arguments === "object" && completed.has(`search:${(value.arguments as { category?: unknown }).category}`)) return { action: null, reason: "NO_PROGRESS" };
  if (typeof value.action !== "string" || !context.allowedActions.includes(value.action as PlannerAction["action"])) return { action: null, reason: "ACTION_NOT_ALLOWED" };
  if (!value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments)) return { action: null, reason: "INVALID_ARGUMENTS" };
  const args = value.arguments as Record<string, unknown>;
  // These descriptions are audit metadata, never authority. Normalize them locally
  // so a harmless wording difference cannot bypass or stall the action schema.
  const normalized = { ...value, ...progressByAction[value.action as PlannerAction["action"]] } as unknown as PlannerAction;
  if (value.action === "search_products") {
    const category = args.category;
    const valid = ["cleanser", "serum", "moisturizer", "travel"].includes(String(category)) && (context.goal.categories.includes(String(category)) || context.goal.targetSku && PRODUCTS_BY_SKU[context.goal.targetSku]?.category === category);
    if (!valid || Object.keys(args).length !== 1) return { action: null, reason: "CATEGORY_OUT_OF_SCOPE" };
    const key = `search:${category}`;
    if (completed.has(key)) return { action: null, reason: "NO_PROGRESS" };
    return { action: normalized, reason: "ALLOWED" };
  }
  if (value.action === "compare_products") {
    if (Object.keys(args).length !== 1 || !Array.isArray(args.skus) || args.skus.length !== 2 || new Set(args.skus).size !== 2 || args.skus.some((sku) => typeof sku !== "string" || !context.productFits.some((fit) => fit.sku === sku && fit.status === "eligible"))) return { action: null, reason: "SKU_NOT_ELIGIBLE" };
    if (completed.has(`compare:${[...args.skus].sort().join("+")}`)) return { action: null, reason: "NO_PROGRESS" };
    return { action: normalized, reason: "ALLOWED" };
  }
  if (value.action === "ask_user") {
    if (Object.keys(args).length !== 1 || typeof args.field !== "string" || !context.requiredMissingFields.includes(args.field as typeof context.requiredMissingFields[number])) return { action: null, reason: "QUESTION_NOT_REQUIRED" };
    return { action: normalized, reason: "ALLOWED" };
  }
  if (value.action === "finalize") {
    if (Object.keys(args).length) return { action: null, reason: "INVALID_ARGUMENTS" };
    if (context.hardConstraints.safety === "active_risk") return { action: null, reason: "SAFETY_STOP" };
    if (context.requiredMissingFields.length) return { action: null, reason: "REQUIRED_FIELD_MISSING" };
    if (context.goal.type === "buy_product" && context.goal.categories.some((category) => !completed.has(`search:${category}`)) && !context.requiredMissingFields.length) return { action: null, reason: "EVIDENCE_REQUIRED" };
    if (context.goal.type === "buy_product" && (!context.rawCandidateSkus.length || !context.productFits.some((fit) => fit.status === "eligible"))) return { action: null, reason: "EVIDENCE_REQUIRED" };
    return { action: normalized, reason: "ALLOWED" };
  }
  return { action: null, reason: "INVALID_ACTION" };
}

function executeProductSearch(current: AgentContext, category: "cleanser" | "serum" | "moisturizer" | "travel", completed: ReadonlySet<string>) {
  const found = searchProducts({ category });
  const safety = checkSafety({ userState: current.userState });
  if (safety.status === "active_risk") return { context: { ...current, productFits: [], candidateProducts: [] }, moreSearches: false, eligibleCount: 0, safetyStop: true };
  const eligibility = checkEligibility({ skus: found.products.map((product) => product.sku), userState: current.userState, memories: current.habits.relevant });
  const rejectedProducts = [...current.rejectedProducts];
  const accepted: ProductFit[] = [];
  const observations: ToolObservation[] = [...current.observations];
  const observe = (tool: ToolObservation["tool"], outcome: string, data?: unknown) => observations.push({ order: observations.length + 1, tool, outcome, data });
  observe("search_products", `${category}: ${found.products.map((product) => product.sku).join("、")}`, { skus: found.products.map((product) => product.sku) });
  observe("check_safety", safety.status);
  observe("check_eligibility", `已检查 ${eligibility.fits.length} 个候选`);
  for (const fit of eligibility.fits) {
    if (fit.status === "excluded") { rejectedProducts.push({ sku: fit.sku, reason: fit.blockers.join("；"), stage: "eligibility" }); continue; }
    const quote = checkBudget({ skus: [fit.sku], budgetFen: current.hardConstraints.budgetFen, mode: "single" });
    observe("check_budget", `${fit.sku}: ${quote.totalFen ?? "未知"} 分`);
    if (quote.withinBudget === false) { rejectedProducts.push({ sku: fit.sku, reason: "超过当前预算", stage: "budget" }); continue; }
    accepted.push({ ...fit, safetyStatus: safety.status, hardConstraintMatch: true, budgetStatus: quote.withinBudget === null ? "unknown" : "within", fitEvidenceIds: fit.evidence.map((item) => item.id), productFactIds: fit.evidence.filter((item) => item.id.startsWith("catalog:")).map((item) => item.id) });
  }
  const rawCandidateSkus = [...new Set([...current.rawCandidateSkus, ...found.products.map((product) => product.sku)])];
  const productFits = [...current.productFits.filter((fit) => !found.products.some((product) => product.sku === fit.sku)), ...accepted];
  const provisional = { ...current, rawCandidateSkus, productFits, candidateProducts: productFits, rejectedProducts, observations, completedActions: observations.map((item) => item.tool) };
  const requiredMissingFields = requiredInformation(provisional, decide(current.userState as UserState, [...current.habits.relevant]));
  const searched = new Set([...completed, `search:${category}`]);
  const moreSearches = current.goal.categories.some((item) => !searched.has(`search:${item}`));
  const eligibleCount = productFits.filter((fit) => fit.status === "eligible").length;
  const context: AgentContext = { ...provisional, requiredMissingFields, pendingQuestions: requiredMissingFields,
    allowedActions: moreSearches ? ["search_products"] : requiredMissingFields.length ? ["ask_user"] : eligibleCount >= 2 ? ["compare_products", "finalize"] : eligibleCount === 1 ? ["finalize"] : [] };
  return { context, moreSearches, eligibleCount, safetyStop: false };
}

export function prepareDeterministicCandidates(initial: AgentContext): AgentContext {
  let context = initial;
  const completed = new Set<string>();
  const categories = context.goal.categories.length ? context.goal.categories : context.goal.targetSku ? [PRODUCTS_BY_SKU[context.goal.targetSku]?.category] : [];
  for (const category of categories) {
    if (!category || !["cleanser", "serum", "moisturizer", "travel"].includes(category)) continue;
    const searched = executeProductSearch(context, category as "cleanser" | "serum" | "moisturizer" | "travel", completed);
    context = searched.context;
    completed.add(`search:${category}`);
    if (searched.safetyStop) break;
  }
  return context;
}

export interface PlannerLoopResult {
  context: AgentContext;
  trace: Array<{ step: number; action: string; policy: "allowed" | "rejected"; reason: string }>;
  audits: ModelAudit[];
  fallbackReason?: string;
  questionField?: StateField;
  comparisonField?: StateField;
}

export async function runPlannerLoop(context: AgentContext, planner: { plan(context: AgentContext, timeoutMs: number): Promise<{ proposal: unknown; audit: ModelAudit }> }, deadlineAt: number): Promise<PlannerLoopResult> {
  let current = context;
  const trace: PlannerLoopResult["trace"] = [];
  const audits: ModelAudit[] = [];
  const completed = new Set<string>();
  let rejected = 0;
  for (let step = 0; step < MAX_PLANNER_STEPS; step++) {
    const remaining = deadlineAt - Date.now();
    if (remaining < MIN_FINAL_RESERVE_MS) return { context: current, trace, audits, fallbackReason: "TIME_BUDGET_EXHAUSTED" };
    current = { ...current, step, remainingTimeBudget: remaining };
    let planned: Awaited<ReturnType<typeof planner.plan>>;
    try {
      planned = await planner.plan(current, Math.min(2_500, remaining - MIN_FINAL_RESERVE_MS));
    } catch {
      trace.push({ step, action: "invalid", policy: "rejected", reason: "PLANNER_EXCEPTION" });
      return { context: current, trace, audits, fallbackReason: "PLANNER_EXCEPTION" };
    }
    const checked = authorizePlannerAction(planned.proposal, current, completed);
    audits.push({ ...planned.audit, schemaSuccess: planned.proposal !== null, businessAccepted: checked.action !== null, used: checked.action !== null, ...(!checked.action ? { failureReason: planned.audit.failureReason ?? checked.reason } : {}) });
    trace.push({ step, action: planned.proposal && typeof planned.proposal === "object" ? String((planned.proposal as { action?: unknown }).action ?? "invalid") : "invalid", policy: checked.action ? "allowed" : "rejected", reason: planned.proposal ? checked.reason : planned.audit.failureReason ?? checked.reason });
    if (!checked.action) {
      if (!planned.proposal) return { context: current, trace, audits, fallbackReason: planned.audit.failureReason ?? "PLANNER_UNAVAILABLE" };
      if (++rejected >= 2) return { context: current, trace, audits, fallbackReason: checked.reason };
      continue;
    }
    rejected = 0;
    const action = checked.action;
    if (action.action === "finalize") return { context: { ...current, step: step + 1 }, trace, audits };
    if (action.action === "ask_user") return { context: { ...current, step: step + 1 }, trace, audits, questionField: action.arguments.field };
    if (action.action === "search_products") {
      const searched = executeProductSearch(current, action.arguments.category, completed);
      current = searched.context;
      if (searched.safetyStop) return { context: current, trace, audits, fallbackReason: "SAFETY_STOP" };
      completed.add(`search:${action.arguments.category}`);
      const exhausted = exhaustedLowRiskQuestion(current);
      if (!searched.moreSearches && exhausted) return comparableFits(current).length === 2
        ? { context: current, trace, audits, comparisonField: exhausted }
        : { context: current, trace, audits, fallbackReason: "LOW_RISK_UNRESOLVED" };
      if (!searched.moreSearches && !current.requiredMissingFields.length && searched.eligibleCount === 0) return { context: current, trace, audits, fallbackReason: "NO_ELIGIBLE_CANDIDATE" };
    } else {
      const compared = compareProducts({ skus: action.arguments.skus, fits: current.productFits });
      const observations: ToolObservation[] = [...current.observations, { order: current.observations.length + 1, tool: "compare_products", outcome: `已比较 ${action.arguments.skus.join("、")}`, data: compared.items.map((item) => ({ sku: item.product.sku, priceFen: item.product.priceFen, features: item.product.features })) }];
      current = { ...current, observations, completedActions: observations.map((item) => item.tool) };
      completed.add(`compare:${[...action.arguments.skus].sort().join("+")}`);
    }
  }
  return { context: { ...current, step: MAX_PLANNER_STEPS }, trace, audits, fallbackReason: "STEP_LIMIT" };
}
