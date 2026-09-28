import assert from "node:assert/strict";
import test from "node:test";
import { buildAgentContext } from "../lib/guide/agent-context";
import { clarificationGoalKey } from "../lib/guide/clarification";
import { authorizePlannerAction, runPlannerLoop } from "../lib/guide/planner";
import { applyDelta, deterministicExtract } from "../lib/guide/state";
import type { ModelAudit, PlannerAction, SessionRecord, UserState } from "../lib/guide/types";

function context(text: string) {
  const state = applyDelta({ facts: {}, history: [], turn: 0 } as UserState, deterministicExtract(text));
  const session: SessionRecord = { id: "s", userId: null, state, inputVersion: 1, appliedInputVersion: 1, stateVersion: 1, result: null };
  return buildAgentContext({ session });
}

const audit: ModelAudit = { stage: "planner", model: "fake", modelInvoked: true, parseSuccess: true, schemaSuccess: true, businessAccepted: false, used: false, latencyMs: 1 };
const action = (name: PlannerAction["action"], args: object): PlannerAction => ({ action: name, arguments: args, evidenceNeeded: "商品事实", expectedProgress: "增加可用证据" } as PlannerAction);

test("planner search automatically runs mandatory safety, eligibility and budget gates", async () => {
  const choices = [action("search_products", { category: "cleanser" }), action("finalize", {})];
  const result = await runPlannerLoop(context("我是干皮，预算200，想买洗面奶"), { async plan() { return { proposal: choices.shift(), audit }; } }, Date.now() + 40_000);
  assert.equal(result.fallbackReason, undefined);
  assert.equal(result.context.productFits.some((fit) => fit.sku === "P101" && fit.status === "eligible"), true);
  assert.deepEqual(result.context.observations.slice(0, 4).map((item) => item.tool), ["search_products", "check_safety", "check_eligibility", "check_budget"]);
  assert.equal(result.context.step, 2);
});

test("action policy rejects unknown category, unsearched SKU and unsafe finalize", () => {
  const base = context("想买洗面奶");
  assert.equal(authorizePlannerAction(action("search_products", { category: "serum" }), base, new Set()).reason, "CATEGORY_OUT_OF_SCOPE");
  assert.equal(authorizePlannerAction(action("compare_products", { skus: ["P101", "P102"] }), base, new Set()).reason, "ACTION_NOT_ALLOWED");
  assert.equal(authorizePlannerAction(action("finalize", {}), context("想买洗面奶，脸很疼"), new Set()).reason, "SAFETY_STOP");
});

test("planner audit wording cannot change action authority", () => {
  const base = context("想买洗面奶");
  const approved = authorizePlannerAction({ action: "search_products", arguments: { category: "cleanser" }, evidenceNeeded: { text: "wrong shape" } }, base, new Set());
  assert.equal(approved.reason, "ALLOWED");
  assert.equal(approved.action?.evidenceNeeded, "当前品类的商品事实");
  assert.equal(authorizePlannerAction({ action: "search_products", arguments: { category: "serum" } }, base, new Set()).reason, "CATEGORY_OUT_OF_SCOPE");
});

test("duplicate search gets one retry then stops without progress", async () => {
  const choices = [action("search_products", { category: "cleanser" }), action("search_products", { category: "cleanser" }), action("search_products", { category: "cleanser" })];
  const result = await runPlannerLoop(context("我是干皮，想买洗面奶"), { async plan() { return { proposal: choices.shift(), audit }; } }, Date.now() + 40_000);
  assert.equal(result.fallbackReason, "NO_PROGRESS");
  assert.equal(result.trace.filter((item) => item.policy === "rejected").length, 2);
});

test("planner failure and short remaining budget exit to deterministic fallback", async () => {
  const unavailable = await runPlannerLoop(context("想买洗面奶"), { async plan() { return { proposal: null, audit: { ...audit, failureReason: "timeout" } }; } }, Date.now() + 40_000);
  assert.equal(unavailable.fallbackReason, "timeout");
  const short = await runPlannerLoop(context("想买洗面奶"), { async plan() { throw new Error("must_not_call"); } }, Date.now() + 10_000);
  assert.equal(short.fallbackReason, "TIME_BUDGET_EXHAUSTED");
});

test("bundle goal cannot finalize before each category has been searched", async () => {
  const choices = [
    action("search_products", { category: "cleanser" }),
    action("finalize", {}),
    action("search_products", { category: "moisturizer" }),
    action("finalize", {}),
  ];
  const result = await runPlannerLoop(context("我是干皮，预算500，想买洗面奶和面霜"), { async plan() { return { proposal: choices.shift(), audit }; } }, Date.now() + 40_000);
  assert.equal(result.trace[1]?.reason, "EVIDENCE_REQUIRED");
  assert.equal(result.fallbackReason, undefined);
  assert.ok(result.context.rawCandidateSkus.includes("P101"));
  assert.ok(result.context.rawCandidateSkus.includes("P202"));
});

test("planner exception is recorded and does not escape the loop", async () => {
  const result = await runPlannerLoop(context("想买洗面奶"), { async plan() { throw new Error("network"); } }, Date.now() + 40_000);
  assert.equal(result.fallbackReason, "PLANNER_EXCEPTION");
  assert.equal(result.trace[0]?.policy, "rejected");
});

test("planner asks one required field and cannot finalize before it is known", async () => {
  const choices = [action("search_products", { category: "cleanser" }), action("finalize", {}), action("ask_user", { field: "skinType" })];
  const result = await runPlannerLoop(context("想买洗面奶"), { async plan() { return { proposal: choices.shift(), audit }; } }, Date.now() + 40_000);
  assert.equal(result.trace[1]?.reason, "REQUIRED_FIELD_MISSING");
  assert.equal(result.questionField, "skinType");
  assert.deepEqual(result.context.requiredMissingFields, ["skinType"]);
});

test("one qualified item or explicit delegated choice does not require a ranking preference", async () => {
  for (const message of ["预算150，想买洗面奶", "想买洗面奶，你帮我定一款"]) {
    const choices = [action("search_products", { category: "cleanser" }), action("finalize", {})];
    const result = await runPlannerLoop(context(message), { async plan() { return { proposal: choices.shift(), audit }; } }, Date.now() + 40_000);
    assert.equal(result.fallbackReason, undefined, message);
    assert.deepEqual(result.context.requiredMissingFields, [], message);
  }
});

test("four unresolved low-risk questions end in a factual comparison without finalize", async () => {
  const initial = context("想买洗面奶");
  const prior = { ...initial, clarification: { goalKey: clarificationGoalKey(initial.userState as UserState), candidateKey: "P101+P102", field: "skinType" as const, askedCount: 4, reason: "肤质会改变排序" } };
  const result = await runPlannerLoop(prior, { async plan() { return { proposal: action("search_products", { category: "cleanser" }), audit }; } }, Date.now() + 40_000);
  assert.equal(result.comparisonField, "skinType");
  assert.equal(result.questionField, undefined);
  assert.deepEqual(result.context.requiredMissingFields, ["skinType"]);
});
