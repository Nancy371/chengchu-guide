import assert from "node:assert/strict";
import test from "node:test";
import { fact } from "../lib/guide/state";
import { verifiedState } from "../lib/guide/verified-state";
import type { ModelAudit, StateField, UserState } from "../lib/guide/types";

const empty = (): UserState => ({ facts: {}, history: [], turn: 0 });

type Case = { name: string; before?: string[]; text: string; expected: Partial<Record<StateField, unknown>>; historical?: StateField };
const cases: Case[] = [
  { name: "pain", text: "我现在脸很疼", expected: { pain: true, currentDiscomfort: true } },
  { name: "stinging", text: "现在刺痛", expected: { stinging: true, currentDiscomfort: true } },
  { name: "damage", text: "皮肤破损", expected: { skinDamage: true, currentDiscomfort: true } },
  { name: "redness", text: "现在红肿", expected: { otherDiscomfort: true, currentDiscomfort: true } },
  { name: "pain and damage", text: "脸很疼，皮肤破损", expected: { pain: true, skinDamage: true, currentDiscomfort: true } },
  { name: "negated sting with damage", text: "没有刺痛，但皮肤破损", expected: { stinging: false, skinDamage: true, currentDiscomfort: true } },
  { name: "negated pain with sting", text: "没有疼痛，但现在刺痛", expected: { pain: false, stinging: true, currentDiscomfort: true } },
  { name: "negated damage with pain", text: "没有破损，不过脸很疼", expected: { skinDamage: false, pain: true, currentDiscomfort: true } },
  { name: "only negation is not all clear", text: "没有刺痛", expected: { stinging: false, currentDiscomfort: undefined } },
  { name: "partial negation retains pain", before: ["脸很疼"], text: "没有刺痛", expected: { stinging: false, pain: true, currentDiscomfort: true } },
  { name: "partial negation retains damage", before: ["皮肤破损"], text: "没有刺痛", expected: { stinging: false, skinDamage: true, currentDiscomfort: true } },
  { name: "partial negation retains two risks", before: ["脸很疼，皮肤破损"], text: "没有刺痛", expected: { pain: true, skinDamage: true, currentDiscomfort: true } },
  { name: "recovery clears pain", before: ["脸很疼"], text: "已经恢复了", expected: { pain: false, currentDiscomfort: false }, historical: "pain" },
  { name: "recovery clears damage", before: ["皮肤破损"], text: "现在没事了", expected: { skinDamage: false, currentDiscomfort: false }, historical: "skinDamage" },
  { name: "recovery clears several", before: ["刺痛，皮肤破损"], text: "完全好了", expected: { stinging: false, skinDamage: false, currentDiscomfort: false } },
  { name: "specific sting recovery keeps damage", before: ["刺痛，皮肤破损"], text: "刺痛已经消失", expected: { stinging: false, skinDamage: true, currentDiscomfort: true } },
  { name: "specific damage recovery keeps pain", before: ["脸很疼，皮肤破损"], text: "破损已经恢复", expected: { skinDamage: false, pain: true, currentDiscomfort: true } },
  { name: "vague discomfort", text: "皮肤有点不舒服", expected: { otherDiscomfort: "unclear", currentDiscomfort: "unclear" } },
  { name: "vague discomfort cannot clear damage", before: ["皮肤破损"], text: "好像不舒服", expected: { skinDamage: true, currentDiscomfort: true } },
  { name: "past pain is not current", text: "以前脸很疼", expected: { pain: undefined, currentDiscomfort: undefined } },
  { name: "past damage is not current", text: "去年皮肤破损", expected: { skinDamage: undefined, currentDiscomfort: undefined } },
  { name: "past pain and present recovery", text: "以前脸很疼，现在没事了", expected: { pain: false, currentDiscomfort: false } },
  { name: "past pain and present damage", text: "以前脸很疼，现在皮肤破损", expected: { pain: undefined, skinDamage: true, currentDiscomfort: true } },
  { name: "other person's pain", text: "帮朋友买，她脸很疼", expected: { pain: undefined, currentDiscomfort: undefined } },
  { name: "other person's damage", text: "替别人咨询，皮肤破损", expected: { skinDamage: undefined, currentDiscomfort: undefined } },
  { name: "dry skin is not discomfort", text: "我是干皮", expected: { skinType: "dry", currentDiscomfort: undefined } },
  { name: "budget initial", text: "预算 400，想买洁面", expected: { budget: 40000, categories: ["cleanser"] } },
  { name: "budget correction", before: ["预算 400"], text: "预算从 400 改成 450", expected: { budget: 45000 }, historical: "budget" },
  { name: "budget lower", before: ["预算 450"], text: "降到 100", expected: { budget: 10000 }, historical: "budget" },
  { name: "category switch", before: ["P101 多少钱"], text: "现在只买保湿面霜", expected: { categories: ["moisturizer"], targetSku: undefined }, historical: "targetSku" },
  { name: "category switch with contradictory SKU", before: ["P101 多少钱"], text: "只买保湿，P101 呢", expected: { categories: ["moisturizer"], targetSku: undefined }, historical: "targetSku" },
  { name: "cleanser switch", before: ["P202 多少钱"], text: "现在只买洁面", expected: { categories: ["cleanser"], targetSku: undefined }, historical: "targetSku" },
  { name: "same category retains SKU", before: ["P101 多少钱"], text: "还是看洁面", expected: { categories: ["cleanser"], targetSku: "P101" } },
  { name: "new compatible SKU", before: ["P101 多少钱"], text: "只买洁面，P102 呢", expected: { categories: ["cleanser"], targetSku: "P102" }, historical: "targetSku" },
  { name: "legacy risk persists", text: "没有刺痛", expected: { currentDiscomfort: true, stinging: false } },
  { name: "legacy recovery", text: "已经恢复了", expected: { currentDiscomfort: false } },
  { name: "no invented skin type", text: "想买洗面奶", expected: { skinType: undefined, categories: ["cleanser"] } },
  { name: "fragrance correction", before: ["必须无香"], text: "可以接受香味", expected: { fragrancePreference: "accepts_fragrance" }, historical: "fragrancePreference" },
  { name: "acid novice", text: "没用过果酸", expected: { acidExperience: false } },
  { name: "acid experienced", text: "用过果酸", expected: { acidExperience: true } },
];

test(`verified state table covers ${cases.length} sourced scenarios`, async (t) => {
  for (const item of cases) await t.test(item.name, async () => {
    let state = empty();
    if (item.name.startsWith("legacy ")) {
      state = { facts: { currentDiscomfort: { field: "currentDiscomfort", value: true, quote: "旧会话风险", turn: 1, status: "confirmed", extractedBy: "local" } }, history: [], turn: 1 };
    }
    for (const message of item.before ?? []) state = (await verifiedState.update({ currentState: state, userMessage: message })).state;
    const result = await verifiedState.update({ currentState: state, userMessage: item.text });
    assert.equal(result.state.turn, state.turn + 1);
    for (const [field, expected] of Object.entries(item.expected)) assert.deepEqual(fact(result.state, field as StateField), expected, `${item.name}: ${field}`);
    if (item.name === "legacy risk persists") assert.equal(result.state.facts.currentDiscomfort?.quote, "旧会话风险");
    if (item.name === "partial negation retains pain") assert.match(result.state.facts.currentDiscomfort?.quote ?? "", /疼/);
    if (item.historical) assert.equal(result.state.history.some((entry) => entry.field === item.historical), true, item.name);
    for (const field of ["stinging", "pain", "skinDamage", "otherDiscomfort"] as const) {
      const sourced = result.state.facts[field];
      if (sourced && sourced.turn === result.state.turn) assert.equal(item.text.includes(sourced.quote), true, `${item.name}: ${field} source`);
    }
  });
});

const audit: ModelAudit = { stage: "extract", model: "fake", modelInvoked: true, parseSuccess: true, schemaSuccess: true, businessAccepted: false, used: false, latencyMs: 1 };

test("forged model safety claims are rejected with an audit trail", async () => {
  const result = await verifiedState.update({ currentState: empty(), userMessage: "脸很疼，想买洗面奶", extract: async () => ({ audit, proposal: { updates: [
    { field: "currentDiscomfort", value: false, quote: "脸很疼", status: "confirmed" },
    { field: "skinType", value: "dry", quote: "想买洗面奶", status: "confirmed" },
  ], signals: [], lifestyle: [] } }) });
  assert.equal(fact(result.state, "pain"), true);
  assert.equal(fact(result.state, "currentDiscomfort"), true);
  assert.equal(result.rejectedProposals.length, 2);
});

test("extractor failure uses the same local transition", async () => {
  const result = await verifiedState.update({ currentState: empty(), userMessage: "没有刺痛，但皮肤破损", extract: async () => { throw new Error("offline"); } });
  assert.equal(fact(result.state, "stinging"), false);
  assert.equal(fact(result.state, "skinDamage"), true);
  assert.equal(result.audit.model?.failureReason, "extractor_threw");
});

test("short skin answers only apply in response to a skin question", async () => {
  const initial = (await verifiedState.update({ currentState: empty(), userMessage: "想买洗面奶" })).state;
  const dry = await verifiedState.update({ currentState: initial, userMessage: "干", pendingQuestion: "skinType" });
  const oily = await verifiedState.update({ currentState: initial, userMessage: "出油", pendingQuestion: "skinType" });
  const unrelated = await verifiedState.update({ currentState: initial, userMessage: "干" });
  assert.equal(fact(dry.state, "skinType"), "dry");
  assert.equal(fact(oily.state, "skinType"), "oily");
  assert.equal(fact(unrelated.state, "skinType"), undefined);
  assert.equal(fact(dry.state, "currentDiscomfort"), undefined);
});

test("a vague answer to the pending sensitivity question remains unconfirmed", async () => {
  const initial = (await verifiedState.update({ currentState: empty(), userMessage: "想买果酸，用过果酸，现在状态稳定" })).state;
  const vague = await verifiedState.update({ currentState: initial, userMessage: "还可以", pendingQuestion: "sensitiveTendency", extract: async () => ({ audit, proposal: { updates: [{ field: "sensitiveTendency", value: false, quote: "还可以", status: "confirmed" }], signals: [{ kind: "communication", value: "answer_ambiguous", quote: "还可以", explicit: true, subject: "self", temporal: "current" }], lifestyle: [] } }) });
  assert.equal(fact(vague.state, "sensitiveTendency"), undefined);
  assert.equal(vague.understanding.signals.some((item) => item.value === "answer_ambiguous"), true);
  assert.equal(vague.rejectedProposals.length, 1);
  const unrelated = await verifiedState.update({ currentState: initial, userMessage: "还可以" });
  assert.equal(unrelated.understanding.signals.some((item) => item.value === "answer_ambiguous"), false);
  const clear = await verifiedState.update({ currentState: initial, userMessage: "不敏感", pendingQuestion: "sensitiveTendency" });
  assert.equal(fact(clear.state, "sensitiveTendency"), false);
});

test("explicit scent liking can be normalized without inventing a product scent", async () => {
  const local = await verifiedState.update({ currentState: empty(), userMessage: "我喜欢桂花香" });
  assert.equal(fact(local.state, "fragrancePreference"), "accepts_fragrance");
  const semantic = await verifiedState.update({ currentState: empty(), userMessage: "桂花味挺好闻", extract: async () => ({ audit, proposal: { updates: [{ field: "fragrancePreference", value: "accepts_fragrance", quote: "桂花味挺好闻", status: "confirmed" }], signals: [], lifestyle: [] } }) });
  assert.equal(fact(semantic.state, "fragrancePreference"), "accepts_fragrance");
  assert.equal(semantic.state.facts.fragrancePreference?.quote, "桂花味挺好闻");
  const negated = await verifiedState.update({ currentState: empty(), userMessage: "我不喜欢桂花香", extract: async () => ({ audit, proposal: { updates: [{ field: "fragrancePreference", value: "accepts_fragrance", quote: "我不喜欢桂花香", status: "confirmed" }], signals: [], lifestyle: [] } }) });
  assert.equal(fact(negated.state, "fragrancePreference"), undefined);
});
