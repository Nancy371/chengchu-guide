import { PRODUCTS_BY_SKU } from "./catalog";
import { classifyPurchaseAction, fact } from "./state";
import type { DecisionResult, Product, PurchaseGoal, PurchaseTask, StateField, TurnUnderstanding, UserState } from "./types";

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
    updatedTurn: state.turn,
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
  return null;
}

export function updatePurchaseTask(input: { previous?: PurchaseTask; previousState: UserState; currentState: UserState; understanding: TurnUnderstanding; userMessage: string }): PurchaseTask {
  const previous = structuredClone(input.previous ?? input.previousState.purchaseTask ?? rebuildPurchaseTask(input.previousState));
  const action = input.understanding.purchaseAction ?? classifyPurchaseAction(input.userMessage, previous.pendingQuestion?.field);
  const proposedGoal = action.kind === "price_interruption" || action.kind === "policy_interruption" || action.kind === "request_alternative" || action.kind === "decline_answer" || action.kind === "end"
    ? null : explicitGoal(input.understanding, input.userMessage, previous.goal.version);
  const changedGoal = proposedGoal && proposedGoal.key !== previous.goal.key;
  const nextGoal = changedGoal ? proposedGoal : previous.goal;
  let pendingQuestion = previous.pendingQuestion;
  let displayedSkus = previous.displayedSkus;
  let budget = previous.budget;

  if (changedGoal) {
    pendingQuestion = undefined;
    displayedSkus = [];
    budget = { status: "unknown", goalVersion: nextGoal.version };
  }
  const budgetUpdate = input.understanding.delta.updates.find((item) => item.field === "budget")?.value;
  if (typeof budgetUpdate === "number") budget = { status: "limited", fen: budgetUpdate, goalVersion: nextGoal.version };
  else if (/预算不限|不限预算|不设预算|没有预算限制|价格无所谓|多少钱都可以/.test(input.userMessage.replace(/\s+/g, ""))) budget = { status: "unlimited", goalVersion: nextGoal.version };
  else if (action.kind === "decline_answer" && pendingQuestion?.field === "budget") budget = { status: "declined", goalVersion: nextGoal.version };

  if (pendingQuestion && action.kind === "answer_question" && input.understanding.delta.updates.some((item) => item.field === pendingQuestion?.field)) pendingQuestion = undefined;
  if (pendingQuestion?.field === "budget" && (budget.status === "limited" || budget.status === "unlimited")) pendingQuestion = undefined;
  if (action.kind === "decline_answer") pendingQuestion = undefined;
  if (action.kind === "end") pendingQuestion = undefined;

  return { goal: nextGoal, ...(pendingQuestion ? { pendingQuestion } : {}), displayedSkus, turnAction: action, budget, updatedTurn: input.currentState.turn };
}

export function stateForPurchaseTask(state: UserState, task: PurchaseTask): UserState {
  const copy = structuredClone(state);
  const facts = { ...copy.facts };
  const sourced = (field: StateField, value: string | number | string[]) => ({ field, value, quote: "purchase_task", turn: state.turn, status: "confirmed" as const, extractedBy: "local" as const });
  if (task.goal.kind === "categories") {
    if (task.goal.categories.length) facts.categories = sourced("categories", task.goal.categories);
    else delete facts.categories;
    if (task.goal.targetSku) facts.targetSku = sourced("targetSku", task.goal.targetSku);
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
  const same = task.pendingQuestion?.field === field;
  return { ...task, pendingQuestion: { field, askedCount: same ? task.pendingQuestion!.askedCount + 1 : 1, reason } };
}

export function completePurchaseTask(task: PurchaseTask, result: Pick<DecisionResult, "action" | "candidateSkus" | "recommendations">): PurchaseTask {
  const displayed = ["recommend", "comparison_only"].includes(result.action)
    ? [...new Set([...task.displayedSkus, ...result.candidateSkus, ...result.recommendations.map((item) => item.sku)])]
    : task.displayedSkus;
  return { ...task, displayedSkus: displayed };
}

export function taskNeedsAlternative(task: PurchaseTask) {
  return task.turnAction.kind === "request_alternative";
}
