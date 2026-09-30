import assert from "node:assert/strict";
import test from "node:test";
import { completePurchaseTask, rebuildPurchaseTask, stateForPurchaseTask, transitionPurchaseTask, updatePurchaseTask } from "../lib/guide/purchase-task";
import { applyDelta, deterministicUnderstand, fact } from "../lib/guide/state";
import type { DecisionResult, PurchaseTask, UserState } from "../lib/guide/types";

const empty = (): UserState => ({ facts: {}, history: [], turn: 0 });

function advance(previousState: UserState, previous: PurchaseTask | undefined, text: string) {
  const understanding = deterministicUnderstand(text, previous?.pendingQuestion?.field);
  const currentState = applyDelta(previousState, understanding.delta);
  const task = updatePurchaseTask({ previous, previousState, currentState, understanding, userMessage: text });
  return { state: { ...currentState, purchaseTask: task }, task };
}

test("purchase task separates a goal from price and policy interruptions", () => {
  const first = advance(empty(), undefined, "预算 200，想买洗面奶");
  assert.deepEqual(first.task.goal.categories, ["cleanser"]);
  assert.equal(first.task.budget.status, "limited");
  assert.equal(first.task.budget.fen, 20000);

  const price = advance(first.state, first.task, "P101 多少钱？");
  assert.equal(price.task.turnAction.kind, "ask_about_product");
  assert.equal(price.task.turnAction.topic, "price");
  assert.deepEqual(price.task.goal.categories, ["cleanser"]);
  assert.equal(price.task.budget.fen, 20000);

  const policy = advance(price.state, price.task, "现在有赠品吗？");
  assert.equal(policy.task.turnAction.kind, "policy_interruption");
  assert.deepEqual(policy.task.goal.categories, ["cleanser"]);
});

test("switching the purchase goal clears its budget, pending question, and displayed products", () => {
  const first = advance(empty(), undefined, "预算 200，想买洗面奶");
  const seeded: PurchaseTask = { ...first.task, displayedSkus: ["P101"], pendingQuestion: { field: "fragrancePreference", askedCount: 2, reason: "区分候选" } };
  const switched = advance({ ...first.state, purchaseTask: seeded }, seeded, "现在改看保湿面霜");
  assert.deepEqual(switched.task.goal.categories, ["moisturizer"]);
  assert.equal(switched.task.goal.version, first.task.goal.version + 1);
  assert.equal(switched.task.budget.status, "unknown");
  assert.deepEqual(switched.task.displayedSkus, []);
  assert.equal(switched.task.pendingQuestion, undefined);
  assert.equal(fact(stateForPurchaseTask(switched.state, switched.task), "budget"), undefined);
});

test("gift box wording remains ambiguous until the user identifies the catalog travel kit", () => {
  const gift = advance(empty(), undefined, "我想要礼盒");
  assert.equal(gift.task.goal.kind, "gift_box_ambiguous");
  const travel = advance(gift.state, gift.task, "旅行分装那种");
  assert.equal(travel.task.goal.kind, "categories");
  assert.deepEqual(travel.task.goal.categories, ["travel"]);
  assert.equal(travel.task.budget.status, "unknown");
});

test("budget answers and refusals update only the current goal", () => {
  const first = advance(empty(), undefined, "想买洗面奶");
  const pending: PurchaseTask = { ...first.task, pendingQuestion: { field: "budget", askedCount: 1, reason: "推荐前确认预算" } };
  const unlimited = advance({ ...first.state, purchaseTask: pending }, pending, "不限预算");
  assert.equal(unlimited.task.turnAction.kind, "answer_question");
  assert.equal(unlimited.task.budget.status, "unlimited");
  assert.equal(unlimited.task.pendingQuestion, undefined);

  const again: PurchaseTask = { ...first.task, pendingQuestion: { field: "budget", askedCount: 1, reason: "推荐前确认预算" } };
  const declined = advance({ ...first.state, purchaseTask: again }, again, "预算不想说，别再问了");
  assert.equal(declined.task.budget.status, "declined");
  assert.equal(declined.task.pendingQuestion, undefined);
});

test("only a committed display is added to the current goal history", () => {
  const task = rebuildPurchaseTask(applyDelta(empty(), deterministicUnderstand("预算 300，想买洗面奶").delta));
  const result = { action: "recommend", candidateSkus: ["P101"], recommendations: [{ sku: "P101" }] } as Pick<DecisionResult, "action" | "candidateSkus" | "recommendations">;
  assert.deepEqual(completePurchaseTask(task, result).displayedSkus, ["P101"]);
  assert.deepEqual(completePurchaseTask(task, { ...result, action: "clarify" }).displayedSkus, []);
});

test("post-recommendation language is classified as a purchase event rather than a user fact", () => {
  assert.equal(deterministicUnderstand("合适").purchaseAction?.kind, "accept_current");
  assert.equal(deterministicUnderstand("不合适").purchaseAction?.kind, "reject_current");
  assert.equal(deterministicUnderstand("可以", "fragrancePreference").purchaseAction?.kind, "answer_question");

  const why = deterministicUnderstand("为什么不推荐 P102");
  assert.equal(why.purchaseAction?.kind, "ask_why_not");
  assert.deepEqual(why.skuMentions, [{ sku: "P102", quote: "P102", role: "inquiry" }]);
  assert.equal(why.delta.updates.some((item) => item.field === "targetSku"), false);

  const selected = deterministicUnderstand("就要 P102");
  assert.equal(selected.purchaseAction?.kind, "select_product");
  assert.deepEqual(selected.skuMentions, [{ sku: "P102", quote: "P102", role: "selection" }]);
});

test("rejecting a current recommendation creates an effective exclusion but commits it only with the reply", () => {
  const state = applyDelta(empty(), deterministicUnderstand("预算200，想买洗面奶").delta);
  const base = {
    ...rebuildPurchaseTask(state),
    decisionStage: "recommended" as const,
    currentRecommendation: { primarySku: "P101", alternativeSkus: ["P102"], inputVersion: 1 },
    displayedSkus: ["P101", "P102"],
  };
  const understanding = deterministicUnderstand("不合适");
  const currentState = applyDelta(state, understanding.delta);
  const transition = transitionPurchaseTask({ previous: base, previousState: state, currentState, understanding, userMessage: "不合适", inputVersion: 2 });

  assert.deepEqual(transition.effectiveRejectedSkus, ["P101"]);
  assert.equal(transition.nextRequiredAction, "clarify_rejection_reason");
  assert.equal(transition.task.pendingTaskQuestion?.field, "rejectionReason");
  assert.deepEqual(transition.task.rejectedSkus, []);

  const result = { action: "clarify", candidateSkus: [], recommendations: [], versions: { input: 2, state: 2, knowledge: "test" } } as Pick<DecisionResult, "action" | "candidateSkus" | "recommendations" | "versions">;
  assert.deepEqual(completePurchaseTask(transition.task, result).rejectedSkus, []);
  const committed = completePurchaseTask(transition.task, result, transition);
  assert.deepEqual(committed.rejectedSkus?.map((item) => item.sku), ["P101"]);
  assert.equal(committed.currentRecommendation, undefined);
  assert.equal(committed.decisionStage, "clarifying_rejection");
});

test("accepting or explicitly selecting a product becomes durable only after result commit", () => {
  const state = applyDelta(empty(), deterministicUnderstand("预算200，想买洗面奶").delta);
  const base = { ...rebuildPurchaseTask(state), decisionStage: "recommended" as const, currentRecommendation: { primarySku: "P101", alternativeSkus: ["P102"], inputVersion: 1 } };
  const acceptedUnderstanding = deterministicUnderstand("合适");
  const accepted = transitionPurchaseTask({ previous: base, previousState: state, currentState: state, understanding: acceptedUnderstanding, userMessage: "合适", inputVersion: 2 });
  assert.equal(accepted.commit.selectedSku, "P101");
  assert.equal(accepted.task.selectedSku, undefined);

  const result = { action: "recommend", candidateSkus: ["P101"], recommendations: [{ sku: "P101" }], versions: { input: 2, state: 2, knowledge: "test" } } as Pick<DecisionResult, "action" | "candidateSkus" | "recommendations" | "versions">;
  assert.equal(completePurchaseTask(accepted.task, result, accepted).selectedSku, "P101");

  const explicitUnderstanding = deterministicUnderstand("就要 P102");
  const explicit = transitionPurchaseTask({ previous: base, previousState: state, currentState: state, understanding: explicitUnderstanding, userMessage: "就要 P102", inputVersion: 2 });
  assert.equal(explicit.commit.selectedSku, "P102");
});
