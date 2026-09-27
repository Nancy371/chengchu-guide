import assert from "node:assert/strict";
import test from "node:test";
import { planConversation, renderTemplate, validateRenderProposal } from "../lib/guide/conversation";
import { decide } from "../lib/guide/decision";
import { applyDelta, deterministicExtract, deterministicUnderstand, fact } from "../lib/guide/state";
import type { DecisionResult, HabitMemory, UserState } from "../lib/guide/types";

function stateFrom(...turns: string[]): UserState {
  return turns.reduce((state, text) => applyDelta(state, deterministicExtract(text)), { facts: {}, history: [], turn: 0 } as UserState);
}

function memory(kind: HabitMemory["kind"], value: string | boolean): HabitMemory {
  return { id: kind, kind, value, sourceTurn: 1, updatedAt: 1, expiresAt: Date.now() + 100_000 };
}

test("a ¥100 cleanser request reports no budget candidate without irrelevant questions", () => {
  const state = stateFrom("预算大概 100，想买洗面奶");
  const draft = decide(state);
  assert.equal(draft.action, "budget_conflict");
  assert.deepEqual(draft.questionFields, []);
  assert.deepEqual(draft.recommendations, []);
  const plan = planConversation({ draft, state, signals: [], lifestyle: [], memories: [], updatedFields: ["budget", "categories"] });
  assert.deepEqual(plan.policy.selectedQuestionFields, []);
  assert.match(renderTemplate(plan, []).reply, /没有预算内的选择/);
});

test("a low budget is not treated as an emotion", () => {
  const understanding = deterministicUnderstand("预算 100，想买洗面奶");
  assert.equal(understanding.signals.some((item) => item.kind === "emotion"), false);
});

test("explicit frustration is acknowledged before narrowing the task", () => {
  const text = "选半天了越看越烦，就想简单一点，只看洁面";
  const understanding = deterministicUnderstand(text);
  const state = applyDelta({ facts: {}, history: [], turn: 0 }, understanding.delta);
  const draft = decide(state);
  const plan = planConversation({ draft, state, signals: understanding.signals, lifestyle: understanding.lifestyle, memories: [], updatedFields: understanding.delta.updates.map((item) => item.field) });
  assert.equal(plan.policy.userEmotion, "frustrated");
  assert.equal(plan.policy.behaviorSkills.includes("emotion_acknowledgement"), true);
  const reply = renderTemplate(plan, understanding.signals).reply;
  assert.match(reply, /耗神|范围收小/);
  assert.doesNotMatch(reply, /根据您的需求|请问您|为了更好地|我理解你的心情/);
  assert.equal(plan.policy.selectedQuestionFields.length <= 1, true);
});

test("explicit rejection closes without recommendation or follow-up", () => {
  const text = "算了，不买了";
  const understanding = deterministicUnderstand(text);
  const state = applyDelta(stateFrom("想买洗面奶"), understanding.delta);
  const draft = decide(state);
  const plan = planConversation({ draft, state, signals: understanding.signals, lifestyle: understanding.lifestyle, memories: [], updatedFields: understanding.delta.updates.map((item) => item.field) });
  assert.equal(plan.policy.nextAction, "close");
  assert.deepEqual(plan.policy.selectedQuestionFields, []);
  assert.equal(plan.policy.behaviorSkills.includes("respectful_close"), true);
});

test("‘算了，还是看保湿’ changes direction instead of closing the conversation", () => {
  const first = stateFrom("我想看洁面");
  const text = "算了，还是只看保湿吧，我不想加太多步骤";
  const understanding = deterministicUnderstand(text);
  const state = applyDelta(first, understanding.delta);
  const draft = decide(state);
  const plan = planConversation({ draft, state, signals: understanding.signals, lifestyle: understanding.lifestyle, memories: [], updatedFields: understanding.delta.updates.map((item) => item.field) });

  assert.notEqual(plan.policy.nextAction, "close");
  assert.equal(understanding.signals.some((item) => item.value === "reject"), false);
  assert.equal(understanding.signals.some((item) => item.value === "correction"), true);
  assert.match(renderTemplate(plan, understanding.signals).reply, /滋润和清爽/);
  assert.doesNotMatch(renderTemplate(plan, understanding.signals).reply, /影响洁面的选择/);
});

test("transient online-price intent does not leak into the next turn", () => {
  const state = stateFrom("P101 网上便宜，能同价吗", "我想买洗面奶");
  assert.equal(fact(state, "policyTopics"), undefined);
  assert.equal(fact(state, "claimedOnlinePrice"), undefined);
  assert.notEqual(decide(state).action, "policy_unknown");
});

test("current statement overrides an older fragrance memory", () => {
  const saved = [memory("fragrance_preference", "must_be_fragrance_free")];
  const oldPreference = decide(stateFrom("偏油，想买洗面奶"), saved);
  assert.equal(oldPreference.recommendations.some((item) => item.sku === "P102"), false);
  const current = decide(stateFrom("偏油，想买洗面奶，可以接受香味"), saved);
  assert.equal(current.recommendations[0]?.sku, "P102");
});

test("two recommendations are alternatives rather than a bundle total", () => {
  const result = decide(stateFrom("我是干皮，想买洗面奶"));
  if (result.recommendations.length > 1) {
    assert.equal(result.pricingMode, "alternatives");
    assert.equal(result.totalFen, undefined);
  }
});

test("the renderer cannot inject SKU, prices, promises or extra questions", () => {
  const state = stateFrom("想买洗面奶");
  const draft = decide(state);
  const plan = planConversation({ draft, state, signals: [], lifestyle: [], memories: [], updatedFields: ["categories"] });
  assert.equal(validateRenderProposal({
    acknowledgement: "",
    blockIds: plan.factBlocks.map((item) => item.id),
    questions: plan.policy.selectedQuestionFields.map((field) => ({ field, text: "买 P101 吧，只要 ¥99，一定有效" })),
    closing: "",
  }, plan), null);
});

test("the renderer rejects unsupported gifts, returns, effects and contact questions", () => {
  const state = stateFrom("想买洗面奶");
  const plan = planConversation({ draft: decide(state), state, signals: [], lifestyle: [], memories: [], updatedFields: ["categories"] });
  const base = { acknowledgement: "", blockIds: plan.factBlocks.map((item) => item.id), questions: [{ field: "skinType", text: "平时偏干还是偏油？" }], closing: "" };
  assert.equal(validateRenderProposal({ ...base, closing: "买就送小样，拆封也能退。" }, plan), null);
  assert.equal(validateRenderProposal({ ...base, closing: "还能美白淡斑。" }, plan), null);
  assert.equal(validateRenderProposal({ ...base, closing: "请留下地址和电话？" }, plan), null);
});

test("the renderer rejects robotic phrasing and stacked questions", () => {
  const state = stateFrom("想买洗面奶");
  const draft = decide(state);
  const plan = planConversation({ draft, state, signals: [], lifestyle: [], memories: [], updatedFields: ["categories"] });
  const field = plan.policy.selectedQuestionFields[0];
  assert.ok(field);
  assert.equal(validateRenderProposal({
    acknowledgement: "",
    blockIds: plan.factBlocks.map((item) => item.id),
    questions: [{ field, text: "请问您是什么肤质？平时会敏感吗？" }],
    closing: "",
  }, plan), null);
});

test("a previously asked optional field is not immediately repeated", () => {
  const state = stateFrom("偏油，想买洗面奶");
  const draft = decide(state);
  const previousResult = { questionFields: ["fragrancePreference"] } as DecisionResult;
  const plan = planConversation({ draft, state, signals: [], lifestyle: [], memories: [], previousResult, updatedFields: [] });
  assert.deepEqual(plan.policy.selectedQuestionFields, []);
});

test("a changed product category can reframe a still-critical question", () => {
  const state = stateFrom("想买保湿，步骤越少越好");
  const draft = decide(state);
  const previousResult = { questionFields: ["skinType"] } as DecisionResult;
  const plan = planConversation({ draft, state, signals: [], lifestyle: [], memories: [], previousResult, updatedFields: ["categories"] });
  assert.deepEqual(plan.policy.selectedQuestionFields, ["skinType"]);
});

test("durable habits are explicit, self-owned, and do not include temporary travel", () => {
  const own = deterministicUnderstand("我经常出差，而且一直喜欢轻薄不黏的质地");
  assert.equal(own.lifestyle.some((item) => item.kind === "frequent_travel" && item.scope === "durable" && item.subject === "self"), true);
  const other = deterministicUnderstand("帮朋友买，她经常出差");
  assert.equal(other.lifestyle.every((item) => item.subject === "other"), true);
  const temporary = deterministicUnderstand("我这周要旅行");
  assert.equal(temporary.lifestyle.some((item) => item.kind === "frequent_travel"), false);
});
