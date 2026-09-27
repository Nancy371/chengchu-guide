import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentContext } from "../lib/guide/agent-context";
import { authorizeFinalDecision } from "../lib/guide/final-decision";
import { runPlannerLoop } from "../lib/guide/planner";
import { applyDelta, deterministicExtract } from "../lib/guide/state";
import type { ModelAudit, SessionRecord, UserState } from "../lib/guide/types";

const audit: ModelAudit = { stage: "planner", model: "fake", modelInvoked: true, parseSuccess: true, schemaSuccess: true, businessAccepted: true, used: true, latencyMs: 1 };
async function searched(...turns: string[]) {
  const state = turns.reduce((previous, text) => applyDelta(previous, deterministicExtract(text)), { facts: {}, history: [], turn: 0 } as UserState);
  const session: SessionRecord = { id: "s", userId: null, state, inputVersion: turns.length, appliedInputVersion: turns.length, stateVersion: turns.length, result: null };
  const initial = buildAgentContext({ session, memoryVersion: 3 });
  const category = initial.goal.categories[0] ?? "cleanser";
  const choices = [{ action: "search_products", arguments: { category }, evidenceNeeded: "商品事实", expectedProgress: "检索候选" }, { action: "finalize", arguments: {}, evidenceNeeded: "候选", expectedProgress: "进入裁决" }];
  const result = await runPlannerLoop(initial, { async plan() { return { proposal: choices.shift(), audit }; } }, Date.now() + 40_000);
  return result.context;
}
function current(context: Awaited<ReturnType<typeof searched>>) { return { ...context.versions, memory: context.habits.version }; }

test("final reasoner may recommend only eligible, evidenced, budgeted candidates", async () => {
  const context = await searched("我是干皮，预算200，想买洗面奶");
  const good = authorizeFinalDecision({ context, current: current(context), proposal: { kind: "recommend", skus: ["P101"], evidenceIds: ["catalog:P101"], relation: "single" } });
  assert.equal(good.status, "APPROVED");
  assert.equal(good.decision?.totalFen, 16900);
  for (const proposal of [
    { kind: "recommend", skus: ["P201"], evidenceIds: ["catalog:P201"], relation: "single" },
    { kind: "recommend", skus: ["P101", "P101"], evidenceIds: ["catalog:P101"], relation: "alternatives" },
    { kind: "recommend", skus: ["P101"], evidenceIds: ["gift:P101"], relation: "single" },
    { kind: "recommend", skus: ["P101"], evidenceIds: ["catalog:P101"], relation: "bundle" },
  ]) assert.notEqual(authorizeFinalDecision({ context, current: current(context), proposal }).status, "APPROVED");
});

test("question field must be a current required gap", async () => {
  const context = await searched("想买洗面奶");
  assert.equal(context.requiredMissingFields.includes("skinType"), true);
  const ask = authorizeFinalDecision({ context, current: current(context), proposal: { kind: "ask", field: "skinType", questionGoal: "区分滋润和清爽", evidenceGap: "肤质未提供" } });
  assert.equal(ask.status, "APPROVED");
  assert.equal(ask.decision?.questionFields[0], "skinType");
  assert.equal(authorizeFinalDecision({ context, current: current(context), proposal: { kind: "ask", field: "budget", questionGoal: "预算", evidenceGap: "预算" } }).status, "FALLBACK_REQUIRED");
});

test("safety, budget and version changes cannot be overridden", async () => {
  const budget = await searched("我是干皮，预算100，想买洗面奶");
  assert.equal(authorizeFinalDecision({ context: budget, current: current(budget), proposal: { kind: "recommend", skus: ["P101"], evidenceIds: ["catalog:P101"], relation: "single" } }).status, "FALLBACK_REQUIRED");
  const damaged = await searched("我想买果酸，皮肤破损，用过果酸，不敏感");
  assert.equal(damaged.productFits.length, 0);
  assert.equal(authorizeFinalDecision({ context: damaged, current: current(damaged), proposal: { kind: "recommend", skus: ["P201"], evidenceIds: ["catalog:P201"], relation: "single" } }).status, "FALLBACK_REQUIRED");
  const valid = await searched("我是干皮，预算200，想买洗面奶");
  assert.equal(authorizeFinalDecision({ context: valid, current: { ...current(valid), input: valid.versions.input + 1 }, proposal: { kind: "direct", source: "fallback", reason: "test" } }).status, "STALE");
  assert.equal(authorizeFinalDecision({ context: valid, current: { ...current(valid), memory: 4 }, proposal: { kind: "direct", source: "fallback", reason: "test" } }).status, "STALE");
});
