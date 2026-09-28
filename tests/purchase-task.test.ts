import assert from "node:assert/strict";
import test from "node:test";
import { completePurchaseTask, rebuildPurchaseTask, stateForPurchaseTask, updatePurchaseTask } from "../lib/guide/purchase-task";
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
  assert.equal(price.task.turnAction.kind, "price_interruption");
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
