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
  assert.match(reply, /挺累|范围收小/);
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
  assert.match(renderTemplate(plan, understanding.signals).reply, /先看保湿/);
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

test("two-product copy explains each option once and comparison cannot smuggle in a main pick", () => {
  const state = stateFrom("我是干皮，想买洗面奶");
  const recommended = planConversation({ draft: decide(state), state, signals: [], lifestyle: [], memories: [], updatedFields: [] });
  const recommendedText = recommended.factBlocks.map((block) => block.text).join(" ");
  assert.equal((recommendedText.match(/P101/g) ?? []).length, 1);
  assert.equal((recommendedText.match(/P102/g) ?? []).length, 1);
  assert.match(recommendedText, /¥169/);
  assert.match(recommendedText, /¥149/);
  assert.equal(recommendedText.includes("两个备选"), false);
  assert.equal(recommended.factBlocks.length, 1);
  assert.doesNotMatch(recommendedText, /手册适用提示|资格门禁|候选排序|匹配得分/);
  const compared = planConversation({ draft: { ...decide(state), action: "comparison_only", recommendations: [], candidateSkus: ["P101", "P102"], questionFields: [], totalFen: undefined }, state, signals: [], lifestyle: [], memories: [], updatedFields: [] });
  assert.equal(validateRenderProposal({ acknowledgement: "", blockIds: compared.factBlocks.map((block) => block.id), questions: [], closing: "我主推第一款。" }, compared), null);
});

test("recommendation copy connects the confirmed need to a product without inventing a scent note", () => {
  const state = stateFrom("我偏油，喜欢桂花香，想买洗面奶，预算200元");
  const draft = decide(state);
  const plan = planConversation({ draft, state, signals: [], lifestyle: [], memories: [], updatedFields: [] });
  const text = renderTemplate(plan, []).reply;
  assert.equal(draft.action, "recommend");
  assert.match(text, /你说自己偏油/);
  assert.match(text, /清洁感较强/);
  assert.doesNotMatch(text, /桂花香|手册适用提示|资格门禁/);
  assert.equal(plan.factBlocks.length, 1);
});

test("a real two-product bundle has one joined explanation and the verified total", () => {
  const state = stateFrom("我是干皮，想买洁面和保湿，预算450元");
  const draft = decide(state);
  const plan = planConversation({ draft, state, signals: [], lifestyle: [], memories: [], updatedFields: [] });
  const text = renderTemplate(plan, []).reply;
  assert.equal(draft.pricingMode, "bundle");
  assert.equal(plan.factBlocks.length, 1);
  assert.match(text, /两件合计 ¥428/);
  assert.equal((text.match(/P101/g) ?? []).length, 1);
  assert.equal((text.match(/P202/g) ?? []).length, 1);
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

test("the renderer cannot deny an already-known purchase category", () => {
  const state = stateFrom("想买洗面奶");
  const plan = planConversation({ draft: decide(state), state, signals: [], lifestyle: [], memories: [], updatedFields: ["categories"] });
  const questions = plan.policy.selectedQuestionFields.map((field) => ({ field, text: field === "budget" ? "这次预算大概想控制在多少？" : "这一点你更倾向哪一边？" }));
  assert.equal(validateRenderProposal({
    acknowledgement: "你还没说具体想看哪类，我先帮你圈个范围。",
    blockIds: plan.factBlocks.map((item) => item.id),
    questions,
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

test("a still-needed field remains askable after an unclear reply", () => {
  const state = stateFrom("偏油，想买洗面奶");
  const draft = decide(state);
  const previousResult = { questionFields: ["fragrancePreference"] } as DecisionResult;
  const plan = planConversation({ draft, state, signals: [], lifestyle: [], memories: [], previousResult, updatedFields: [] });
  assert.deepEqual(plan.policy.selectedQuestionFields, ["fragrancePreference"]);
});

test("a vague answer retries a needed sensitivity question in concrete words", () => {
  const state = stateFrom("想买果酸，用过果酸，现在状态稳定");
  const draft = decide(state);
  const previousResult = { questionFields: ["sensitiveTendency"] } as DecisionResult;
  const ambiguous = deterministicUnderstand("还可以", "sensitiveTendency");
  const plan = planConversation({ draft, state, signals: ambiguous.signals, lifestyle: [], memories: [], previousResult, updatedFields: [] });
  assert.deepEqual(plan.policy.selectedQuestionFields, ["sensitiveTendency"]);
  assert.match(plan.questionGoals[0].fallback, /用新护肤品.*泛红、刺痛/);
});

test("a changed product category can reframe a still-critical question", () => {
  const state = stateFrom("想买保湿，步骤越少越好");
  const draft = decide(state);
  const previousResult = { questionFields: ["skinType"] } as DecisionResult;
  const plan = planConversation({ draft, state, signals: [], lifestyle: [], memories: [], previousResult, updatedFields: ["categories"] });
  assert.deepEqual(plan.policy.selectedQuestionFields, ["skinType"]);
});

test("a confirmed budget is acknowledged before the next single question", () => {
  const understanding = deterministicUnderstand("预算200，想买洗面奶");
  const state = applyDelta({ facts: {}, history: [], turn: 0 } as UserState, understanding.delta);
  const plan = planConversation({
    draft: decide(state),
    state,
    signals: understanding.signals,
    lifestyle: understanding.lifestyle,
    memories: [],
    updatedFields: understanding.delta.updates.map((item) => item.field),
  });
  const reply = renderTemplate(plan, []).reply;
  assert.match(reply, /^好，先按 200 元看。/);
  assert.match(reply, /紧绷.*出油呢？/);
  assert.equal((reply.match(/[？?]/g) ?? []).length, 1);
  assert.equal(plan.turnContext.confirmedAnswer?.field, "budget");
  assert.equal(plan.turnContext.nextQuestionGoal?.field, "skinType");
});

test("a rendered follow-up must acknowledge the confirmed answer and ask only the selected question", () => {
  const firstState = stateFrom("想买洗面奶");
  const previousResult = { questionFields: ["skinType"], questions: ["洗完脸后，你更容易觉得紧绷，还是过一会儿会出油呢？"] } as DecisionResult;
  const understanding = deterministicUnderstand("偏油", "skinType");
  const state = applyDelta(firstState, understanding.delta);
  const plan = planConversation({ draft: decide(state), state, signals: [], lifestyle: [], memories: [], previousResult, updatedFields: ["skinType"] });
  const field = plan.policy.selectedQuestionFields[0];
  assert.equal(validateRenderProposal({
    acknowledgement: "好，平时更容易出油这点我记下了。",
    blockIds: [],
    questions: [{ field, text: "带一点香味你能接受，还是更想要无香的呢？" }],
    closing: "",
  }, plan)?.questions.length, 1);
  assert.equal(validateRenderProposal({
    acknowledgement: "好，我们继续。",
    blockIds: [],
    questions: [{ field, text: "带一点香味你能接受，还是更想要无香的呢？" }],
    closing: "",
  }, plan), null);
});

test("durable habits are explicit, self-owned, and do not include temporary travel", () => {
  const own = deterministicUnderstand("我经常出差，而且一直喜欢轻薄不黏的质地");
  assert.equal(own.lifestyle.some((item) => item.kind === "frequent_travel" && item.scope === "durable" && item.subject === "self"), true);
  const other = deterministicUnderstand("帮朋友买，她经常出差");
  assert.equal(other.lifestyle.every((item) => item.subject === "other"), true);
  const temporary = deterministicUnderstand("我这周要旅行");
  assert.equal(temporary.lifestyle.some((item) => item.kind === "frequent_travel"), false);
});
