import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentContext, compileReasoningContext, contextMatchesSession, decideWithContext, decisionTrace } from "../lib/guide/agent-context";
import { applyDelta, deterministicExtract } from "../lib/guide/state";
import type { SessionRecord, UserState } from "../lib/guide/types";

function session(turns: string[], inputVersion = turns.length): SessionRecord {
  const state = turns.reduce((previous, text) => applyDelta(previous, deterministicExtract(text)), { facts: {}, history: [], turn: 0 } as UserState);
  return { id: "test", userId: null, state, inputVersion, appliedInputVersion: inputVersion, stateVersion: inputVersion, result: null };
}

test("context derives goal and ordered observations from the committed state", () => {
  const context = decideWithContext(buildAgentContext({ session: session(["我是干皮，想买洗面奶"]), memoryVersion: 4 }));
  assert.equal(context.goal.type, "buy_product");
  assert.equal(context.step, 0);
  assert.equal(context.currentDecision?.recommendations[0]?.sku, "P101");
  assert.deepEqual(context.observations.map((item) => item.order), context.observations.map((_, index) => index + 1));
  assert.equal(context.completedActions.includes("check_eligibility"), true);
  assert.equal(context.habits.version, 4);
  assert.equal(decisionTrace(context).versions.state, 1);
});

test("budget correction and category switch rebuild context without previous observations", () => {
  const first = decideWithContext(buildAgentContext({ session: session(["预算 400，想配洁面和保湿", "我是干皮"]) }));
  const correctedSession = session(["预算 400，想配洁面和保湿", "我是干皮", "预算从 400 改成 450"]);
  const corrected = decideWithContext(buildAgentContext({ session: correctedSession }));
  assert.equal(first.currentDecision?.action, "budget_conflict");
  assert.equal(corrected.currentDecision?.action, "recommend");
  assert.equal(contextMatchesSession(first, correctedSession), false);
  assert.equal(corrected.observations[0]?.order, 1);
  const switched = decideWithContext(buildAgentContext({ session: session(["P101 多少钱", "现在只看保湿，我是干皮"]) }));
  assert.deepEqual(switched.goal.categories, ["moisturizer"]);
  assert.equal(switched.goal.targetSku, undefined);
  assert.equal(switched.currentDecision?.candidateSkus.includes("P101"), false);
});

test("later safety input yields a fresh safe context and no stale recommendation", () => {
  const first = decideWithContext(buildAgentContext({ session: session(["我是干皮，想买洗面奶"]) }));
  const latestSession = session(["我是干皮，想买洗面奶", "现在脸很疼"]);
  const latest = decideWithContext(buildAgentContext({ session: latestSession }));
  assert.equal(first.currentDecision?.action, "recommend");
  assert.equal(latest.currentDecision?.action, "safety");
  assert.deepEqual(latest.allowedActions, []);
  assert.equal(contextMatchesSession(first, latestSession), false);
  assert.equal(latest.observations[0]?.order, 1);
  assert.equal(JSON.stringify(compileReasoningContext(latest)).includes("test"), false);
});
