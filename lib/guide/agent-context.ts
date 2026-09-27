import { KNOWLEDGE_VERSION, PRODUCTS_BY_SKU } from "./catalog";
import { decide } from "./decision";
import { effectiveStateView, fact } from "./state";
import type { AgentContext, DecisionDraft, DecisionTrace, HabitMemory, SessionRecord, StateField, ToolObservation, UserState } from "./types";

function relevantHabits(state: UserState, memories: readonly HabitMemory[]): HabitMemory[] {
  const categories = fact<string[]>(state, "categories") ?? [];
  return memories.filter((memory) => {
    if (memory.kind === "fragrance_preference" || memory.kind === "texture_preference") return categories.some((category) => category === "cleanser" || category === "moisturizer");
    if (memory.kind === "frequent_travel") return categories.includes("travel");
    return true;
  });
}

function allowedActions(state: UserState): AgentContext["allowedActions"] {
  const safety = fact<boolean | string>(state, "currentDiscomfort");
  if (safety === true) return ["finish"];
  if (safety === "unclear") return ["ask_user", "check_safety", "finish"];
  return ["ask_user", "search_products", "get_product_detail", "check_safety", "check_eligibility", "check_budget", "compare_products", "lookup_policy", "finish"];
}

export function buildAgentContext(input: { session: SessionRecord; memories?: readonly HabitMemory[]; memoryVersion?: number }): AgentContext {
  const state = structuredClone(input.session.state);
  const categories = fact<string[]>(state, "categories") ?? [];
  const storedSku = fact<string>(state, "targetSku");
  const targetSku = storedSku && PRODUCTS_BY_SKU[storedSku] && (!categories.length || categories.includes(PRODUCTS_BY_SKU[storedSku].category)) ? storedSku : undefined;
  const intent = fact<string>(state, "intent");
  const policyTopics = fact<string[]>(state, "policyTopics") ?? [];
  const type: AgentContext["goal"]["type"] = policyTopics.length ? "policy" : intent === "price" ? "price" : categories.length || targetSku ? "buy_product" : "unknown";
  return {
    goal: { type, categories, ...(targetSku ? { targetSku } : {}) },
    userState: state,
    habits: { version: input.memoryVersion ?? 0, relevant: structuredClone(relevantHabits(state, input.memories ?? [])) },
    candidateProducts: [],
    currentDecision: null,
    completedActions: [],
    observations: [],
    pendingQuestions: [],
    allowedActions: allowedActions(state),
    step: 0,
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
    completedActions: observations.map((observation) => observation.tool),
    observations: [...observations],
    pendingQuestions: [...draft.questionFields],
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
