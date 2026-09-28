import { KNOWLEDGE_VERSION, PRODUCTS_BY_SKU } from "./catalog";
import { decide } from "./decision";
import { effectiveStateView, fact } from "./state";
import { checkSafety } from "./tools";
import { clarificationGoalKey } from "./clarification";
import { rebuildPurchaseTask, stateForPurchaseTask } from "./purchase-task";
import type { AgentContext, DecisionDraft, DecisionTrace, HabitMemory, ProductFit, SessionRecord, StateField, ToolObservation, UserState } from "./types";

function relevantHabits(state: UserState, memories: readonly HabitMemory[]): HabitMemory[] {
  const categories = fact<string[]>(state, "categories") ?? [];
  return memories.filter((memory) => {
    if (memory.kind === "fragrance_preference" || memory.kind === "texture_preference") return categories.some((category) => category === "cleanser" || category === "moisturizer");
    if (memory.kind === "frequent_travel") return categories.includes("travel");
    return true;
  });
}

function allowedActions(state: UserState, fits: ReadonlyArray<ProductFit> = []): AgentContext["allowedActions"] {
  const safety = checkSafety({ userState: state });
  if (safety.status === "active_risk" || safety.status === "unclear") return [];
  if (!fact<string[]>(state, "categories")?.length && !fact<string>(state, "targetSku")) return ["ask_user"];
  return fits.some((fit) => fit.status === "eligible") ? ["search_products", "compare_products", "finalize"] : ["search_products"];
}

export function buildAgentContext(input: { session: SessionRecord; memories?: readonly HabitMemory[]; memoryVersion?: number; remainingTimeBudget?: number; previousResult?: SessionRecord["result"] }): AgentContext {
  const checkpointState = structuredClone(input.session.state);
  const purchaseTask = structuredClone(input.previousResult?.purchaseTask ?? checkpointState.purchaseTask ?? rebuildPurchaseTask(checkpointState));
  const state = stateForPurchaseTask(checkpointState, purchaseTask);
  const categories = fact<string[]>(state, "categories") ?? [];
  const storedSku = fact<string>(state, "targetSku");
  const targetSku = storedSku && PRODUCTS_BY_SKU[storedSku] && (!categories.length || categories.includes(PRODUCTS_BY_SKU[storedSku].category)) ? storedSku : undefined;
  const intent = fact<string>(state, "intent");
  const policyTopics = fact<string[]>(state, "policyTopics") ?? [];
  const safety = checkSafety({ userState: state });
  const type: AgentContext["goal"]["type"] = purchaseTask.turnAction.kind === "policy_interruption" || policyTopics.length ? "policy"
    : purchaseTask.turnAction.kind === "price_interruption" || intent === "price" ? "price"
      : purchaseTask.goal.kind !== "categories" || categories.length || targetSku ? "buy_product" : "unknown";
  return {
    goal: { type, categories, ...(targetSku ? { targetSku } : {}) },
    userState: state,
    habits: { version: input.memoryVersion ?? 0, relevant: structuredClone(relevantHabits(state, input.memories ?? [])) },
    candidateProducts: [],
    rawCandidateSkus: [],
    productFits: [],
    rejectedProducts: [],
    hardConstraints: { safety: safety.status, budgetStatus: purchaseTask.budget.status, ...(purchaseTask.budget.status === "limited" ? { budgetFen: purchaseTask.budget.fen } : {}), fragranceFree: fact<string>(state, "fragrancePreference") === "must_be_fragrance_free" },
    softPreferences: { skinType: fact<string>(state, "skinType"), fragrance: fact<string>(state, "fragrancePreference"), concern: fact<string>(state, "coreConcern") },
    requiredMissingFields: purchaseTask.goal.kind === "gift_box_ambiguous" ? ["giftBoxType"] : categories.length || targetSku ? [] : ["categories"],
    currentDecision: null,
    completedActions: [],
    observations: [],
    pendingQuestions: [],
    ...(input.previousResult?.clarification?.goalKey === clarificationGoalKey(state, purchaseTask) ? { clarification: input.previousResult.clarification } : {}),
    purchaseTask,
    allowedActions: allowedActions(state),
    step: 0,
    remainingTimeBudget: input.remainingTimeBudget ?? 40_000,
    versions: { input: input.session.appliedInputVersion, state: input.session.stateVersion, knowledge: KNOWLEDGE_VERSION },
  };
}

export function decideWithContext(context: AgentContext): AgentContext {
  const observations: ToolObservation[] = [...context.observations];
  const draft = decide(context.userState as UserState, [...context.habits.relevant], (tool, outcome) => {
    observations.push({ order: observations.length + 1, tool, outcome });
  });
  return withDecision(context, draft, observations);
}

export function withDecision(context: AgentContext, draft: DecisionDraft, observations: readonly ToolObservation[] = context.observations): AgentContext {
  return {
    ...context,
    currentDecision: draft,
    candidateProducts: draft.productFits,
    productFits: draft.productFits.filter((fit) => fit.status !== "excluded"),
    requiredMissingFields: [...draft.questionFields],
    completedActions: observations.map((observation) => observation.tool),
    observations: [...observations],
    pendingQuestions: [...draft.questionFields],
    allowedActions: allowedActions(context.userState as UserState, draft.productFits),
  };
}

export function compileReasoningContext(context: AgentContext) {
  const draft = context.currentDecision;
  return {
    goal: context.goal,
    userState: effectiveStateView(context.userState as UserState),
    candidateFits: context.candidateProducts.map((fit) => ({ sku: fit.sku, status: fit.status, score: fit.score, matches: fit.matches, blockers: fit.blockers, missing: fit.missing, tradeoffs: fit.tradeoffs, allowedClaims: fit.allowedClaims })),
    routeReason: draft?.routeReason ?? "",
    allowedQuestionFields: draft?.questionFields ?? [] as StateField[],
    versions: context.versions,
  };
}

export function decisionTrace(context: AgentContext): DecisionTrace {
  return {
    tools: context.observations.map(({ tool, outcome }) => ({ tool, outcome })),
    eligibility: context.candidateProducts.map(({ sku, status }) => ({ sku, status })),
    versions: context.versions,
    routeReason: context.currentDecision?.routeReason ?? "",
  };
}

export function contextMatchesSession(context: AgentContext, session: SessionRecord): boolean {
  return context.versions.input === session.appliedInputVersion && context.versions.state === session.stateVersion && context.versions.knowledge === KNOWLEDGE_VERSION;
}
