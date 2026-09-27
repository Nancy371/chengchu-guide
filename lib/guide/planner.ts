import { PRODUCTS_BY_SKU } from "./catalog";
import { decide } from "./decision";
import { checkBudget, checkEligibility, checkSafety, compareProducts, searchProducts } from "./tools";
import type { AgentContext, ModelAudit, PlannerAction, ProductFit, ToolObservation, UserState } from "./types";

export const MAX_PLANNER_STEPS = 5;
const MIN_FINAL_RESERVE_MS = 22_000;

export function compilePlannerContext(context: AgentContext) {
  return {
    goal: context.goal,
    userState: { facts: Object.fromEntries(Object.entries(context.userState.facts).map(([field, value]) => [field, value?.value])) },
    hardConstraints: context.hardConstraints,
    softPreferences: context.softPreferences,
    requiredMissingFields: context.requiredMissingFields,
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
  if (typeof value.action !== "string" || !context.allowedActions.includes(value.action as PlannerAction["action"])) return { action: null, reason: "ACTION_NOT_ALLOWED" };
  if (typeof value.evidenceNeeded !== "string" || typeof value.expectedProgress !== "string" || value.evidenceNeeded.length > 160 || value.expectedProgress.length > 160) return { action: null, reason: "INVALID_PROGRESS" };
  if (!value.arguments || typeof value.arguments !== "object" || Array.isArray(value.arguments)) return { action: null, reason: "INVALID_ARGUMENTS" };
  const args = value.arguments as Record<string, unknown>;
  if (value.action === "search_products") {
    const category = args.category;
    const valid = ["cleanser", "serum", "moisturizer", "travel"].includes(String(category)) && (context.goal.categories.includes(String(category)) || context.goal.targetSku && PRODUCTS_BY_SKU[context.goal.targetSku]?.category === category);
    if (!valid || Object.keys(args).length !== 1) return { action: null, reason: "CATEGORY_OUT_OF_SCOPE" };
    const key = `search:${category}`;
    if (completed.has(key)) return { action: null, reason: "NO_PROGRESS" };
    return { action: value as unknown as PlannerAction, reason: "ALLOWED" };
  }
  if (value.action === "compare_products") {
    if (Object.keys(args).length !== 1 || !Array.isArray(args.skus) || args.skus.length !== 2 || new Set(args.skus).size !== 2 || args.skus.some((sku) => typeof sku !== "string" || !context.productFits.some((fit) => fit.sku === sku && fit.status === "eligible"))) return { action: null, reason: "SKU_NOT_ELIGIBLE" };
    if (completed.has(`compare:${[...args.skus].sort().join("+")}`)) return { action: null, reason: "NO_PROGRESS" };
    return { action: value as unknown as PlannerAction, reason: "ALLOWED" };
  }
  if (value.action === "finalize") {
    if (Object.keys(args).length) return { action: null, reason: "INVALID_ARGUMENTS" };
    if (context.hardConstraints.safety === "active_risk") return { action: null, reason: "SAFETY_STOP" };
    if (context.goal.type === "buy_product" && !context.rawCandidateSkus.length && !context.requiredMissingFields.length) return { action: null, reason: "EVIDENCE_REQUIRED" };
    return { action: value as unknown as PlannerAction, reason: "ALLOWED" };
  }
  return { action: null, reason: "INVALID_ACTION" };
}

export interface PlannerLoopResult {
  context: AgentContext;
  trace: Array<{ step: number; action: string; policy: "allowed" | "rejected"; reason: string }>;
  audits: ModelAudit[];
  fallbackReason?: string;
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
    const planned = await planner.plan(current, Math.min(2_500, remaining - MIN_FINAL_RESERVE_MS));
    audits.push(planned.audit);
    const checked = authorizePlannerAction(planned.proposal, current, completed);
    trace.push({ step, action: planned.proposal && typeof planned.proposal === "object" ? String((planned.proposal as { action?: unknown }).action ?? "invalid") : "invalid", policy: checked.action ? "allowed" : "rejected", reason: checked.reason });
    if (!checked.action) {
      if (!planned.proposal) return { context: current, trace, audits, fallbackReason: planned.audit.failureReason ?? "PLANNER_UNAVAILABLE" };
      if (++rejected >= 2) return { context: current, trace, audits, fallbackReason: checked.reason };
      continue;
    }
    rejected = 0;
    const action = checked.action;
    if (action.action === "finalize") return { context: { ...current, step: step + 1 }, trace, audits };
    if (action.action === "search_products") {
      const found = searchProducts(action.arguments);
      const safety = checkSafety({ userState: current.userState });
      if (safety.status === "active_risk") return { context: { ...current, productFits: [], candidateProducts: [] }, trace, audits, fallbackReason: "SAFETY_STOP" };
      const eligibility = checkEligibility({ skus: found.products.map((product) => product.sku), userState: current.userState, memories: current.habits.relevant });
      const rejectedProducts = [...current.rejectedProducts];
      const accepted: ProductFit[] = [];
      const observations: ToolObservation[] = [...current.observations];
      const observe = (tool: ToolObservation["tool"], outcome: string, data?: unknown) => observations.push({ order: observations.length + 1, tool, outcome, data });
      observe("search_products", `${action.arguments.category}: ${found.products.map((product) => product.sku).join("、")}`, { skus: found.products.map((product) => product.sku) });
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
      const baseline = decide(current.userState as UserState, [...current.habits.relevant]);
      current = { ...current, rawCandidateSkus, productFits, candidateProducts: productFits, rejectedProducts, observations, completedActions: observations.map((item) => item.tool), requiredMissingFields: baseline.questionFields, allowedActions: productFits.filter((fit) => fit.status === "eligible").length >= 2 ? ["search_products", "compare_products", "finalize"] : ["search_products", "finalize"] };
      completed.add(`search:${action.arguments.category}`);
    } else {
      const compared = compareProducts({ skus: action.arguments.skus, fits: current.productFits });
      const observations: ToolObservation[] = [...current.observations, { order: current.observations.length + 1, tool: "compare_products", outcome: `已比较 ${action.arguments.skus.join("、")}`, data: compared.items.map((item) => ({ sku: item.product.sku, priceFen: item.product.priceFen, features: item.product.features })) }];
      current = { ...current, observations, completedActions: observations.map((item) => item.tool) };
      completed.add(`compare:${[...action.arguments.skus].sort().join("+")}`);
    }
  }
  return { context: { ...current, step: MAX_PLANNER_STEPS }, trace, audits, fallbackReason: "STEP_LIMIT" };
}
