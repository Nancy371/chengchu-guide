import { PRODUCTS_BY_SKU } from "./catalog";
import { classifyPurchaseAction, fact } from "./state";
import type { DecisionResult, Product, PurchaseGoal, PurchaseTask, PurchaseTurnAction, StateField, TurnUnderstanding, UserState } from "./types";

const productCategories = new Set<Product["category"]>(["cleanser", "serum", "moisturizer", "travel"]);

function goalKey(kind: PurchaseGoal["kind"], categories: readonly string[], targetSku?: string) {
  return JSON.stringify({ kind, categories: [...categories].sort(), targetSku: targetSku ?? null });
}

function goal(kind: PurchaseGoal["kind"], categories: Product["category"][], version: number, targetSku?: string): PurchaseGoal {
  return { kind, categories, version, key: goalKey(kind, categories, targetSku), ...(targetSku ? { targetSku } : {}) };
}

export function rebuildPurchaseTask(state: UserState): PurchaseTask {
  const categories = (fact<string[]>(state, "categories") ?? []).filter((item): item is Product["category"] => productCategories.has(item as Product["category"]));
  const storedSku = fact<string>(state, "targetSku");
  const targetSku = storedSku && PRODUCTS_BY_SKU[storedSku] && (!categories.length || categories.includes(PRODUCTS_BY_SKU[storedSku].category)) ? storedSku : undefined;
  const budgetFen = fact<number>(state, "budget");
  return {
    goal: goal("categories", categories, categories.length || targetSku ? 1 : 0, targetSku),
    displayedSkus: [],
    turnAction: { kind: "continue", quote: "" },
    budget: budgetFen === undefined ? { status: "unknown", goalVersion: categories.length || targetSku ? 1 : 0 } : { status: "limited", fen: budgetFen, goalVersion: categories.length || targetSku ? 1 : 0 },
    decisionStage: "discovering",
    recommendationHistory: [],
    rejectedSkus: [],
    updatedTurn: state.turn,
  };
}

function normalizedTask(task: PurchaseTask): PurchaseTask {
  return {
    ...task,
    decisionStage: task.decisionStage ?? (task.selectedSku ? "selected" : task.currentRecommendation ? "recommended" : "discovering"),
    recommendationHistory: task.recommendationHistory ?? [],
    rejectedSkus: task.rejectedSkus ?? [],
  };
}

function explicitGoal(understanding: TurnUnderstanding, text: string, currentVersion: number): PurchaseGoal | null {
  const compact = text.replace(/\s+/g, "");
  const giftType = understanding.delta.updates.find((item) => item.field === "giftBoxType")?.value;
  if (giftType === "skincare_gift_box") return goal("unsupported_skincare_gift_box", [], currentVersion + 1);
  if (/礼盒/.test(compact) && !/赠品/.test(compact) && giftType !== "travel_kit" && !/旅行|分装|小瓶/.test(compact)) return goal("gift_box_ambiguous", [], currentVersion + 1);
  const categories = understanding.delta.updates.find((item) => item.field === "categories")?.value;
  const validCategories = Array.isArray(categories) ? categories.filter((item): item is Product["category"] => typeof item === "string" && productCategories.has(item as Product["category"])) : [];
  const targetSku = understanding.delta.updates.find((item) => item.field === "targetSku")?.value;
  const validSku = typeof targetSku === "string" && PRODUCTS_BY_SKU[targetSku] ? targetSku : undefined;
  if (validCategories.length) return goal("categories", validCategories, currentVersion + 1, validSku && validCategories.includes(PRODUCTS_BY_SKU[validSku].category) ? validSku : undefined);
  if (validSku) return goal("categories", [PRODUCTS_BY_SKU[validSku].category], currentVersion + 1, validSku);
  return null;
}

export interface PurchaseTransition {
  task: PurchaseTask;
  effectiveRejectedSkus: string[];
  nextRequiredAction?: "clarify_rejection_reason" | "choose_between_recommendations";
  commit: {
    action: PurchaseTurnAction;
    rejected: NonNullable<PurchaseTask["rejectedSkus"]>;
    selectedSku?: string;
    clearCurrentRecommendation?: boolean;
  };
}

function rejectionReason(text: string): NonNullable<PurchaseTask["rejectedSkus"]>[number]["reason"] {
  const compact = text.replace(/\s+/g, "");
  if (/贵|价格|预算|价位/.test(compact)) return "price";
  if (/香味|味道|香气/.test(compact)) return "fragrance";
  if (/紧绷|拔干|清洁感|洗感|黏|质地|肤感/.test(compact)) return "sensory";
  if (/换个方向|不是这个方向|想看别的/.test(compact)) return "direction";
  if (/因为|原因是|主要是/.test(compact)) return "other";
  return "unknown";
}

function mentionedSkus(action: PurchaseTurnAction, role: NonNullable<PurchaseTurnAction["mentions"]>[number]["role"]): string[] {
  return [...new Set((action.mentions ?? []).filter((item) => item.role === role).map((item) => item.sku))];
}

export function transitionPurchaseTask(input: { previous?: PurchaseTask; previousState: UserState; currentState: UserState; understanding: TurnUnderstanding; userMessage: string; inputVersion?: number }): PurchaseTransition {
  const previous = normalizedTask(structuredClone(input.previous ?? input.previousState.purchaseTask ?? rebuildPurchaseTask(input.previousState)));
  const action = input.understanding.purchaseAction ?? classifyPurchaseAction(input.userMessage, previous.pendingQuestion?.field);
  const proposedGoal = action.kind === "price_interruption" || action.kind === "policy_interruption" || action.kind === "request_alternative" || action.kind === "decline_answer" || action.kind === "end"
    ? null : explicitGoal(input.understanding, input.userMessage, previous.goal.version);
  const changedGoal = proposedGoal && proposedGoal.key !== previous.goal.key;
  const nextGoal = changedGoal ? proposedGoal : previous.goal;
  let pendingQuestion = previous.pendingQuestion;
  let questionCounts = previous.questionCounts ?? {};
  let displayedSkus = previous.displayedSkus;
  let budget = previous.budget;
  let decisionStage = previous.decisionStage;
  let currentRecommendation = previous.currentRecommendation;
  let recommendationHistory = previous.recommendationHistory ?? [];
  let selectedSku = previous.selectedSku;
  let rejectedSkus = previous.rejectedSkus ?? [];
  let pendingTaskQuestion = previous.pendingTaskQuestion;

  if (changedGoal) {
    pendingQuestion = undefined;
    questionCounts = {};
    displayedSkus = [];
    budget = { status: "unknown", goalVersion: nextGoal.version };
    decisionStage = "discovering";
    currentRecommendation = undefined;
    recommendationHistory = [];
    selectedSku = undefined;
    rejectedSkus = [];
    pendingTaskQuestion = undefined;
  }
  const budgetUpdate = input.understanding.delta.updates.find((item) => item.field === "budget")?.value;
  if (typeof budgetUpdate === "number") budget = { status: "limited", fen: budgetUpdate, goalVersion: nextGoal.version };
  else if (/预算不限|不限预算|不设预算|没有预算限制|价格无所谓|多少钱都可以/.test(input.userMessage.replace(/\s+/g, ""))) budget = { status: "unlimited", goalVersion: nextGoal.version };
  else if (action.kind === "decline_answer" && pendingQuestion?.field === "budget") budget = { status: "declined", goalVersion: nextGoal.version };

  if (pendingQuestion && action.kind === "answer_question" && input.understanding.delta.updates.some((item) => item.field === pendingQuestion?.field)) pendingQuestion = undefined;
  if (pendingQuestion?.field === "budget" && (budget.status === "limited" || budget.status === "unlimited")) pendingQuestion = undefined;
  if (action.kind === "decline_answer") pendingQuestion = undefined;
  if (action.kind === "end") pendingQuestion = undefined;

  const rejectedNow: NonNullable<PurchaseTask["rejectedSkus"]> = [];
  let selectedNow: string | undefined;
  let clearCurrentRecommendation = false;
  let nextRequiredAction: PurchaseTransition["nextRequiredAction"];
  if (!changedGoal && action.kind === "reject_current") {
    const targets = mentionedSkus(action, "rejection");
    if (!targets.length && currentRecommendation?.primarySku) targets.push(currentRecommendation.primarySku);
    const reason = rejectionReason(input.userMessage);
    for (const sku of targets) rejectedNow.push({ sku, quote: action.quote, reason, turn: input.currentState.turn });
    if (targets.length) {
      decisionStage = "clarifying_rejection";
      clearCurrentRecommendation = true;
      if (reason === "unknown") {
        pendingTaskQuestion = { field: "rejectionReason", reason: "确认哪一点不合适，避免按同一方向继续推荐", sku: targets[0] };
        nextRequiredAction = "clarify_rejection_reason";
      }
    }
  } else if (!changedGoal && action.kind === "accept_current" && currentRecommendation) {
    if (/都/.test(input.userMessage) && currentRecommendation.alternativeSkus.length) {
      pendingTaskQuestion = { field: "selectionChoice", reason: "确认最终想选哪一款" };
      nextRequiredAction = "choose_between_recommendations";
    } else {
      selectedNow = currentRecommendation.primarySku;
    }
  } else if (!changedGoal && action.kind === "select_product") {
    selectedNow = mentionedSkus(action, "selection")[0];
  }

  const task: PurchaseTask = {
    goal: nextGoal,
    ...(pendingQuestion ? { pendingQuestion } : {}),
    ...(pendingTaskQuestion ? { pendingTaskQuestion } : {}),
    questionCounts,
    displayedSkus,
    turnAction: action,
    budget,
    decisionStage,
    ...(currentRecommendation ? { currentRecommendation } : {}),
    recommendationHistory,
    ...(selectedSku ? { selectedSku } : {}),
    rejectedSkus,
    updatedTurn: input.currentState.turn,
  };
  return {
    task,
    effectiveRejectedSkus: [...new Set([...rejectedSkus.map((item) => item.sku), ...rejectedNow.map((item) => item.sku)])],
    ...(nextRequiredAction ? { nextRequiredAction } : {}),
    commit: { action, rejected: rejectedNow, ...(selectedNow ? { selectedSku: selectedNow } : {}), ...(clearCurrentRecommendation ? { clearCurrentRecommendation: true } : {}) },
  };
}

export function updatePurchaseTask(input: { previous?: PurchaseTask; previousState: UserState; currentState: UserState; understanding: TurnUnderstanding; userMessage: string }): PurchaseTask {
  return transitionPurchaseTask(input).task;
}

export function stateForPurchaseTask(state: UserState, task: PurchaseTask): UserState {
  const copy = structuredClone(state);
  const facts = { ...copy.facts };
  const sourced = (field: StateField, value: string | number | string[]) => ({ field, value, quote: "purchase_task", turn: state.turn, status: "confirmed" as const, extractedBy: "local" as const });
  if (task.goal.kind === "categories") {
    if (task.goal.categories.length) facts.categories = sourced("categories", task.goal.categories);
    else delete facts.categories;
    const interruptedSku = ["price_interruption", "policy_interruption"].includes(task.turnAction.kind) ? fact<string>(state, "targetSku") : undefined;
    if (task.goal.targetSku || interruptedSku) facts.targetSku = sourced("targetSku", task.goal.targetSku ?? interruptedSku!);
    else delete facts.targetSku;
  } else {
    delete facts.categories;
    delete facts.targetSku;
  }
  if (task.budget.status === "limited" && task.budget.fen !== undefined) facts.budget = sourced("budget", task.budget.fen);
  else delete facts.budget;
  return { ...copy, facts, purchaseTask: task };
}

export function askPurchaseQuestion(task: PurchaseTask, field: StateField, reason: string): PurchaseTask {
  const priorCount = task.questionCounts?.[field] ?? (task.pendingQuestion?.field === field ? task.pendingQuestion.askedCount : 0);
  const askedCount = priorCount + 1;
  return { ...task, questionCounts: { ...task.questionCounts, [field]: askedCount }, pendingQuestion: { field, askedCount, reason } };
}

export function completePurchaseTask(task: PurchaseTask, result: Pick<DecisionResult, "action" | "candidateSkus" | "recommendations"> & { versions?: DecisionResult["versions"] }, transition?: PurchaseTransition): PurchaseTask {
  const normalized = normalizedTask(task);
  const displayed = ["recommend", "comparison_only", "price_list"].includes(result.action)
    ? [...new Set([...normalized.displayedSkus, ...result.candidateSkus, ...result.recommendations.map((item) => item.sku)])]
    : normalized.displayedSkus;
  let rejectedSkus = normalized.rejectedSkus ?? [];
  let selectedSku = normalized.selectedSku;
  let currentRecommendation = normalized.currentRecommendation;
  let recommendationHistory = normalized.recommendationHistory ?? [];
  let decisionStage = normalized.decisionStage;
  if (transition) {
    const bySku = new Map(rejectedSkus.map((item) => [item.sku, item]));
    for (const item of transition.commit.rejected) bySku.set(item.sku, item);
    rejectedSkus = [...bySku.values()];
    if (transition.commit.selectedSku) {
      selectedSku = transition.commit.selectedSku;
      rejectedSkus = rejectedSkus.filter((item) => item.sku !== selectedSku);
      decisionStage = "selected";
    }
    if (transition.commit.clearCurrentRecommendation) currentRecommendation = undefined;
  }
  if (result.action === "recommend" && result.recommendations.length) {
    currentRecommendation = {
      primarySku: result.recommendations[0].sku,
      alternativeSkus: result.recommendations.slice(1).map((item) => item.sku),
      inputVersion: result.versions?.input ?? normalized.updatedTurn,
    };
    const latest = recommendationHistory.at(-1);
    if (!latest || latest.primarySku !== currentRecommendation.primarySku || latest.alternativeSkus.join("+") !== currentRecommendation.alternativeSkus.join("+")) recommendationHistory = [...recommendationHistory, currentRecommendation];
    decisionStage = "recommended";
  } else if (normalized.pendingTaskQuestion?.field === "rejectionReason" || transition?.nextRequiredAction === "clarify_rejection_reason") {
    decisionStage = "clarifying_rejection";
  }
  return {
    ...normalized,
    displayedSkus: displayed,
    decisionStage,
    ...(currentRecommendation ? { currentRecommendation } : { currentRecommendation: undefined }),
    recommendationHistory,
    ...(selectedSku ? { selectedSku } : { selectedSku: undefined }),
    rejectedSkus,
    ...(transition ? { lastCommittedAction: transition.commit.action.kind } : {}),
  };
}

export function taskNeedsAlternative(task: PurchaseTask) {
  return task.turnAction.kind === "request_alternative";
}
