import assert from "node:assert/strict";
import test from "node:test";
import { applyReasoningProposal, decide } from "../lib/guide/decision";
import { applyDelta, deterministicExtract, fact, mergeDeltas, validateDelta } from "../lib/guide/state";
import type { StateDelta, UserState } from "../lib/guide/types";

function stateFrom(...turns: string[]): UserState {
  return turns.reduce((state, text) => applyDelta(state, deterministicExtract(text)), { facts: {}, history: [], turn: 0 } as UserState);
}

test("dry cleanser route recommends P101 from explicit skin fact", () => {
  const result = decide(stateFrom("想买洗面奶", "我是干皮"));
  assert.equal(result.action, "recommend");
  assert.equal(result.recommendations[0]?.sku, "P101");
});

test("full skin-type answers are retained without claiming safety", () => {
  for (const phrase of ["我是干皮", "我是干性皮肤", "我是干性肌肤"]) {
    const state = stateFrom("想买洗面奶", phrase);
    assert.equal(fact(state, "skinType"), "dry");
    assert.equal(fact(state, "currentDiscomfort"), undefined);
    assert.equal(decide(state).action, "recommend");
  }
  for (const phrase of ["我是油皮", "我是油性皮肤", "我是油性肌肤"]) {
    const state = stateFrom("想买洗面奶", phrase);
    assert.equal(fact(state, "skinType"), "oily");
    assert.notEqual(decide(state).questionFields[0], "skinType");
  }
});

test("a negated symptom cannot hide active damage, and partial negation cannot clear a safety stop", () => {
  const mixed = stateFrom("我想买果酸，我没有刺痛但皮肤破损，用过果酸，也不敏感");
  assert.equal(fact(mixed, "currentDiscomfort"), true);
  assert.equal(decide(mixed).action, "safety");
  assert.equal(decide(stateFrom("我现在脸很疼", "我没有刺痛")).action, "safety");
  assert.notEqual(decide(stateFrom("我现在脸很疼", "已经恢复了，想买洗面奶，我是干皮")).action, "safety");
});

test("a model cannot falsify safety or skin type using an unrelated literal quote", () => {
  const text = "我现在脸很疼，想买洗面奶";
  const forged: StateDelta = { extraction: "model", warnings: [], updates: [
    { field: "currentDiscomfort", value: false, quote: "我现在脸很疼", status: "confirmed", extractedBy: "model" },
    { field: "skinType", value: "dry", quote: "想买洗面奶", status: "confirmed", extractedBy: "model" },
  ] };
  assert.deepEqual(validateDelta(forged, text)?.updates, []);
});

test("switching category clears an old SKU and decision ignores incompatible stored SKU", () => {
  const first = stateFrom("P101 多少钱");
  const switched = applyDelta(first, deterministicExtract("我是干皮，现在只买保湿面霜"));
  assert.equal(fact(switched, "targetSku"), undefined);
  assert.equal(switched.history.some((item) => item.field === "targetSku" && item.value === "P101"), true);
  assert.equal(decide(switched).recommendations.every((item) => item.sku.startsWith("P2")), true);
  const leaked = { ...switched, facts: { ...switched.facts, targetSku: first.facts.targetSku } };
  assert.equal(decide(leaked).recommendations.every((item) => item.sku.startsWith("P2")), true);
});

test("bundle totals are deterministic and budget conflict is explicit", () => {
  const result = decide(stateFrom("预算 400，想配洁面和保湿", "我是干皮"));
  assert.equal(result.action, "budget_conflict");
  assert.equal(result.totalFen, 42800);
  assert.equal(result.budgetGapFen, 2800);
});

test("budget correction replaces the active constraint but keeps history", () => {
  const state = stateFrom("预算 400，想配洁面和保湿", "预算从 400 改成 450", "我是干皮");
  assert.equal(fact(state, "budget"), 45000);
  assert.equal(state.history.some((item) => item.field === "budget" && item.value === 40000), true);
  assert.equal(decide(state).action, "recommend");
});

test("current pain stops recommendation", () => {
  const result = decide(stateFrom("想买洗面奶，我现在脸很疼"));
  assert.equal(result.action, "safety");
  assert.equal(result.recommendations.length, 0);
});

test("unknown gift policy does not erase verified manual price", () => {
  const result = decide(stateFrom("P101 多少钱？有赠品吗"));
  assert.equal(result.action, "policy_unknown");
  assert.equal(result.recommendations[0]?.priceFen, 16900);
  assert.equal(result.evidence.some((item) => item.id === "price:P101"), true);
});

test("P201 is gated on experience and stable skin", () => {
  const first = decide(stateFrom("我想试果酸改善粗糙"));
  assert.equal(first.action, "clarify");
  const novice = decide(stateFrom("我想试果酸改善粗糙", "我没用过果酸，现在状态稳定，也不敏感"));
  assert.equal(novice.action, "unavailable");
});

test("only-buy correction prevents existing moisturizer text from forming a bundle", () => {
  const state = stateFrom("家里保湿还有，只买洁面，我是干皮");
  assert.deepEqual(fact(state, "categories"), ["cleanser"]);
  assert.equal(decide(state).recommendations[0]?.sku, "P101");
});

test("model delta requires a literal source quote and reasoning cannot revive excluded candidates", () => {
  const invalid: StateDelta = { extraction: "model", warnings: [], updates: [{ field: "skinType", value: "dry", quote: "用户是干皮", status: "confirmed", extractedBy: "model" }] };
  assert.deepEqual(validateDelta(invalid, "想买洗面奶")?.updates, []);
  const state = stateFrom("我对香味敏感，必须无香，偏油，想买洗面奶");
  const draft = decide(state);
  const reasoned = applyReasoningProposal(draft, { candidateSkus: ["P102"], questionFields: [] });
  assert.equal(reasoned.candidateSkus.includes("P102"), false);
  assert.equal(mergeDeltas(null, deterministicExtract("想买洁面")).updates.length > 0, true);
});

test("literal local category wording overrides a stale model category", () => {
  const text = "算了，还是只看保湿吧";
  const merged = mergeDeltas({
    extraction: "model",
    warnings: [],
    updates: [{ field: "categories", value: ["cleanser"], quote: text, status: "confirmed", extractedBy: "model" }],
  }, deterministicExtract(text));

  assert.deepEqual(merged.updates.find((item) => item.field === "categories")?.value, ["moisturizer"]);
});
