import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { DecisionResult, ModelAudit, SessionRecord, UserState } from "../lib/guide/types";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "cloudflare:workers") return { url: "data:text/javascript,export const env={};", shortCircuit: true };
  return nextResolve(specifier, context);
} });

const { ConversationRuntime } = await import("../lib/guide/runtime");

const modelAudit = (stage: ModelAudit["stage"]): ModelAudit => ({ stage, model: "fake", modelInvoked: true, parseSuccess: false, schemaSuccess: false, businessAccepted: false, used: false, latencyMs: 1 });
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

class MemoryRepository {
  session: SessionRecord = { id: "s", userId: null, state: { facts: {}, history: [], turn: 0 }, inputVersion: 0, appliedInputVersion: 0, stateVersion: 0, result: null };
  requests = new Map<string, { text: string; version: number; createdAt: number; status: string; result: DecisionResult | null }>();
  oldPending = false;
  async beginTurn(_sessionId: string, requestId: string, text: string) {
    const old = this.requests.get(requestId);
    if (old) return { duplicate: true, processing: old.status === "processing", session: this.session, inputVersion: old.version, response: old.result };
    const previousResult = this.session.result;
    const version = ++this.session.inputVersion;
    this.session.result = null;
    this.requests.set(requestId, { text, version, createdAt: Date.now() - (this.oldPending ? 20_000 : 0), status: "processing", result: null });
    return { duplicate: false, session: this.session, inputVersion: version, previousResult };
  }
  async getSession() { return structuredClone(this.session); }
  async getPendingInput(_id: string, version: number) {
    const entry = [...this.requests.entries()].find(([, request]) => request.version === version);
    return entry ? { request_id: entry[0], text: entry[1].text, created_at: entry[1].createdAt } : null;
  }
  async commitState(_id: string, inputVersion: number, expected: number, state: UserState) {
    if (this.session.inputVersion < inputVersion || this.session.appliedInputVersion !== inputVersion - 1 || this.session.stateVersion !== expected) return null;
    this.session.state = structuredClone(state);
    this.session.appliedInputVersion = inputVersion;
    this.session.stateVersion++;
    return this.getSession();
  }
  async commitResult(_id: string, requestId: string, version: number, expected: number, result: DecisionResult) {
    const valid = this.session.inputVersion === version && this.session.appliedInputVersion === version && this.session.stateVersion === expected;
    if (valid) this.session.result = result;
    const request = this.requests.get(requestId)!;
    request.status = valid ? "complete" : "stale";
    request.result = result;
    return valid;
  }
  async failTurn(_id: string, requestId: string, result: DecisionResult) {
    const request = this.requests.get(requestId)!;
    request.status = "stale";
    request.result = result;
  }
  async getMemoryProfile() { return { enabled: false, version: 0, memories: [] }; }
}

function runtime(repo: MemoryRepository, options: { renderGate?: ReturnType<typeof deferred>; extractGate?: ReturnType<typeof deferred>; plannerGate?: ReturnType<typeof deferred>; reasonerGate?: ReturnType<typeof deferred>; plannerActions?: unknown[]; reasonerProposal?: unknown; rejectedRender?: boolean; reviewThrows?: boolean; onRender?: () => void } = {}) {
  const model = {
    async extract(text: string) {
      if (options.extractGate && text.includes("P101")) await options.extractGate.promise;
      return { understanding: null, proposal: null, audit: modelAudit("extract") };
    },
    async reason() { return { proposal: null, audits: [modelAudit("reason")] }; },
    async plan() {
      if (options.plannerGate) await options.plannerGate.promise;
      return { proposal: options.plannerActions?.shift() ?? null, audit: modelAudit("planner") };
    },
    async finalDecision() {
      if (options.reasonerGate) await options.reasonerGate.promise;
      return { proposal: options.reasonerProposal ?? null, audit: modelAudit("reason") };
    },
    async render() {
      options.onRender?.();
      if (options.renderGate) await options.renderGate.promise;
      if (options.rejectedRender || options.reviewThrows) return { copy: { reply: "买就送小样，拆封也能退。", questions: [], factBlockIds: [] }, audit: modelAudit("render") };
      return { copy: null, audit: modelAudit("render") };
    },
    async reviewRender() {
      if (options.reviewThrows) throw new Error("review_timeout");
      return { approved: false, audit: { ...modelAudit("render_review"), failureReason: "render_review_rejected" } };
    },
  };
  return new ConversationRuntime(repo as unknown as ConstructorParameters<typeof ConversationRuntime>[0], model as unknown as ConstructorParameters<typeof ConversationRuntime>[1]);
}

test("single-question clarification can use the renderer and still falls back to one grounded question", async () => {
  const repo = new MemoryRepository();
  let renderCalls = 0;
  const result = await runtime(repo, { onRender: () => { renderCalls++; } }).handleTurn("s", "r1", "想买洗面奶");
  assert.equal(result.result.action, "clarify");
  assert.equal(result.result.render.source, "template");
  assert.equal(renderCalls, 1);
  assert.equal(result.result.questions.length, 1);
  assert.equal((result.result.reply.match(/[？?]/g) ?? []).length, 1);
});

async function until(predicate: () => boolean) {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("condition_timeout");
}

test("a later pain message survives a late old recommendation", async () => {
  const repo = new MemoryRepository();
  const gate = deferred();
  const agent = runtime(repo, { renderGate: gate });
  const first = agent.handleTurn("s", "r1", "P101 多少钱");
  await until(() => repo.session.appliedInputVersion === 1);
  const second = await agent.handleTurn("s", "r2", "我现在脸很疼");
  assert.equal(second.result.action, "safety");
  assert.deepEqual(second.result.decisionTrace?.versions, second.result.versions);
  assert.equal(second.result.decisionTrace?.tools.some((item) => item.tool === "check_safety"), true);
  gate.release();
  const old = await first;
  assert.equal(old.stale, true);
  assert.equal(repo.session.result?.action, "safety");
  assert.equal(repo.session.state.facts.pain?.value, true);
  assert.equal(repo.session.appliedInputVersion, 2);
});

test("expired predecessor is replayed locally before the new safety input", async () => {
  const repo = new MemoryRepository();
  repo.oldPending = true;
  const gate = deferred();
  const agent = runtime(repo, { extractGate: gate });
  const first = agent.handleTurn("s", "r1", "P101 多少钱");
  await until(() => repo.session.inputVersion === 1);
  const second = await agent.handleTurn("s", "r2", "没有刺痛，但皮肤破损");
  assert.equal(second.result.action, "safety");
  assert.equal(second.result.decisionTrace?.versions.input, 2);
  assert.equal(second.result.decisionTrace?.eligibility.some((item) => item.status === "eligible"), false);
  assert.equal(repo.session.state.facts.targetSku?.value, undefined);
  assert.equal(repo.session.state.facts.stinging?.value, false);
  assert.equal(repo.session.state.facts.skinDamage?.value, true);
  gate.release();
  assert.equal((await first).stale, true);
  assert.equal(repo.session.state.turn, 2);
});

test("retrying a completed request does not apply its input twice", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const first = await agent.handleTurn("s", "same", "我现在脸很疼");
  const again = await agent.handleTurn("s", "same", "我现在脸很疼");
  assert.equal(first.result.action, "safety");
  assert.equal(again.duplicate, true);
  assert.equal(repo.session.inputVersion, 1);
  assert.equal(repo.session.appliedInputVersion, 1);
  assert.equal(repo.session.state.turn, 1);
  assert.deepEqual(again.result.decisionTrace, first.result.decisionTrace);
});

test("semantic review rejection and failure fall back to the local template", async () => {
  for (const options of [{ rejectedRender: true }, { reviewThrows: true }]) {
    const repo = new MemoryRepository();
    const result = await runtime(repo, options).handleTurn("s", "r1", "我是干皮，想买洗面奶");
    assert.equal(result.result.render.source, "template");
    assert.equal(result.result.reply.includes("送小样"), false);
    assert.equal(result.result.reply.includes("拆封也能退"), false);
    assert.equal(result.result.state.facts.skinType?.value, "dry");
  }
});

test("a vague sensitivity answer advances to a concrete follow-up without guessing", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const first = (await agent.handleTurn("s", "r1", "预算300，想买果酸，用过果酸，现在状态稳定")).result;
  assert.deepEqual(first.questionFields, ["sensitiveTendency"]);
  const second = (await agent.handleTurn("s", "r2", "还可以")).result;
  assert.equal(second.state.facts.sensitiveTendency, undefined);
  assert.deepEqual(second.questionFields, ["sensitiveTendency"]);
  assert.equal(second.questions.length, 1);
  assert.match(second.questions[0], /用新护肤品.*泛红、刺痛/);
  assert.equal(second.recommendations.length, 0);
});

test("an unauthorized final reasoner SKU is rejected and the fallback is authorized", async () => {
  const repo = new MemoryRepository();
  const choices = [
    { action: "search_products", arguments: { category: "cleanser" }, evidenceNeeded: "商品", expectedProgress: "获得候选" },
    { action: "finalize", arguments: {}, evidenceNeeded: "候选", expectedProgress: "进入裁决" },
  ];
  const agent = runtime(repo, { plannerActions: choices, reasonerProposal: { kind: "recommend", skus: ["P201"], evidenceIds: ["catalog:P201"], relation: "single" } });
  const result = (await agent.handleTurn("s", "r1", "我是干皮，预算200，只要无香，想买洗面奶")).result;
  assert.equal(result.agentTrace?.reasonerProposal?.kind, "recommend");
  assert.equal(result.agentTrace?.fallbackReason, "SKU_NOT_AUTHORIZED");
  assert.equal(result.agentTrace?.authorization, "APPROVED");
  assert.ok(result.recommendations.every((item) => item.sku !== "P201"));
});

test("late planner and final reasoner results cannot overwrite a newer safety turn", async () => {
  for (const blockedStage of ["planner", "reasoner"] as const) {
    const repo = new MemoryRepository();
    const gate = deferred();
    const choices = [
      { action: "search_products", arguments: { category: "cleanser" }, evidenceNeeded: "商品", expectedProgress: "获得候选" },
      { action: "finalize", arguments: {}, evidenceNeeded: "候选", expectedProgress: "进入裁决" },
    ];
    const agent = runtime(repo, {
      plannerActions: choices,
      ...(blockedStage === "planner" ? { plannerGate: gate } : { reasonerGate: gate }),
      reasonerProposal: { kind: "recommend", skus: ["P101"], evidenceIds: ["catalog:P101"], relation: "single" },
    });
    const old = agent.handleTurn("s", "r1", "我是干皮，预算200，只要无香，想买洗面奶");
    await until(() => repo.session.appliedInputVersion === 1);
    const newer = await agent.handleTurn("s", "r2", "现在脸很疼");
    assert.equal(newer.result.action, "safety");
    gate.release();
    assert.equal((await old).stale, true, blockedStage);
    assert.equal(repo.session.result?.action, "safety");
    assert.equal(repo.session.state.facts.pain?.value, true);
  }
});

test("four unclear low-risk answers end in a price-correct comparison without a main recommendation", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const first = (await agent.handleTurn("s", "c1", "预算200，想买洗面奶")).result;
  assert.deepEqual(first.questionFields, ["skinType"]);
  assert.equal(first.clarification?.askedCount, 1);
  for (let count = 2; count <= 4; count++) {
    const turn = (await agent.handleTurn("s", `c${count}`, "还可以")).result;
    assert.deepEqual(turn.questionFields, ["skinType"]);
    assert.equal(turn.clarification?.askedCount, count);
    assert.equal(turn.questions.length, 1);
  }
  const compared = (await agent.handleTurn("s", "c5", "还可以")).result;
  assert.equal(compared.action, "comparison_only");
  assert.deepEqual(compared.recommendations, []);
  assert.deepEqual(compared.questions, []);
  assert.match(compared.reply, /¥169/);
  assert.match(compared.reply, /¥149/);
  assert.equal(compared.totalFen, undefined);
  assert.equal(compared.agentTrace?.authorizationReason, "FACTUAL_COMPARISON_ONLY");
});

test("a price interruption retains the unresolved need question without counting as an answer", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const first = (await agent.handleTurn("s", "p1", "想买洗面奶")).result;
  assert.equal(first.clarification?.askedCount, 1);
  const price = (await agent.handleTurn("s", "p2", "P101 多少钱")).result;
  assert.equal(price.action, "price_answer");
  assert.equal(price.clarification?.askedCount, 1);
  const resumed = (await agent.handleTurn("s", "p3", "还可以")).result;
  assert.deepEqual(resumed.questionFields, ["skinType"]);
  assert.equal(resumed.clarification?.askedCount, 2);
});

test("one budget-qualified item or delegated choice can be recommended without guessed skin type", async () => {
  for (const [text, expectedSku] of [["预算150，想买洗面奶", "P102"], ["预算500，想买洗面奶，你帮我定一款", "P101"]]) {
    const repo = new MemoryRepository();
    const result = (await runtime(repo).handleTurn("s", "single", text)).result;
    assert.equal(result.action, "recommend", text);
    assert.equal(result.recommendations.length, 1);
    assert.equal(result.recommendations[0].sku, expectedSku);
    assert.equal(result.state.facts.skinType, undefined);
    assert.equal(result.reply.includes("偏干肤质与手册适用提示一致"), false);
  }
});

test("unclear current discomfort keeps asking without making a comparison", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  for (let turn = 1; turn <= 5; turn++) {
    const result = (await agent.handleTurn("s", `safe${turn}`, turn === 1 ? "皮肤有点不舒服，想买洗面奶" : "还可以")).result;
    assert.equal(result.action, "clarify");
    assert.deepEqual(result.questionFields, ["currentDiscomfort"]);
    assert.equal(result.recommendations.length, 0);
  }
});

test("declining an optional answer stops questions and only compares checked peers", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const first = (await agent.handleTurn("s", "decline1", "预算200，想买洗面奶")).result;
  assert.deepEqual(first.questionFields, ["skinType"]);
  const declined = (await agent.handleTurn("s", "decline2", "不想回答这个")).result;
  assert.equal(declined.action, "comparison_only");
  assert.deepEqual(declined.questionFields, []);
  assert.deepEqual(declined.recommendations, []);
  assert.equal(declined.agentTrace?.authorizationReason, "FACTUAL_COMPARISON_ONLY");
});

test("declining an unresolved safety question does not recommend or ask again this turn", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const first = (await agent.handleTurn("s", "safety1", "皮肤有点不舒服，想买洗面奶")).result;
  assert.deepEqual(first.questionFields, ["currentDiscomfort"]);
  const declined = (await agent.handleTurn("s", "safety2", "不方便说")).result;
  assert.equal(declined.action, "unavailable");
  assert.deepEqual(declined.questionFields, []);
  assert.deepEqual(declined.recommendations, []);
  assert.match(declined.reply, /不能安全推荐/);
  const retry = (await agent.handleTurn("s", "safety3", "还是想买洗面奶")).result;
  assert.deepEqual(retry.questionFields, ["currentDiscomfort"]);
});

test("a purchase advances from preference to budget instead of stopping after an answer", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const first = (await agent.handleTurn("s", "flow1", "我是油皮，想买洗面奶")).result;
  assert.deepEqual(first.questionFields, ["fragrancePreference"]);
  assert.equal(first.questionOptions?.some((item) => item.id === "scent-okay"), true);
  const preference = (await agent.handleTurn("s", "flow2", "我喜欢玫瑰香")).result;
  assert.deepEqual(preference.questionFields, ["budget"]);
  assert.deepEqual(preference.questionOptions?.filter((item) => item.id.startsWith("budget-")).map((item) => item.id), ["budget-150", "budget-200", "budget-unlimited", "budget-decline"]);
  assert.equal(preference.state.facts.fragranceNote?.value, "玫瑰香");
  const budget = (await agent.handleTurn("s", "flow3", preference.questionOptions![1].answerText)).result;
  assert.equal(budget.action, "recommend");
  assert.ok(budget.recommendations.length > 0);
});

test("a safety answer option is verified as a current risk before product selection", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const first = (await agent.handleTurn("s", "option-safe1", "皮肤有点不舒服，想买洗面奶")).result;
  assert.deepEqual(first.questionFields, ["currentDiscomfort"]);
  const answer = first.questionOptions?.find((item) => item.id === "safety-active");
  assert.ok(answer);
  const stopped = (await agent.handleTurn("s", "option-safe2", answer.answerText)).result;
  assert.equal(stopped.action, "safety");
  assert.equal(stopped.state.facts.currentDiscomfort?.value, true);
  assert.deepEqual(stopped.recommendations, []);
});

test("a bare number answers the pending budget question without losing the known category", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const first = (await agent.handleTurn("s", "bare-budget1", "想买支洗面奶")).result;
  assert.deepEqual(first.questionFields, ["skinType"]);
  assert.doesNotMatch(first.reply, /还没说.*哪类/);
  const skin = (await agent.handleTurn("s", "bare-budget2", "偏油")).result;
  assert.deepEqual(skin.questionFields, ["fragrancePreference"]);
  const scent = (await agent.handleTurn("s", "bare-budget3", "带香可以")).result;
  assert.deepEqual(scent.questionFields, ["budget"]);
  const answered = (await agent.handleTurn("s", "bare-budget4", "200")).result;
  assert.notDeepEqual(answered.questionFields, ["budget"]);
  assert.equal(answered.state.facts.budget?.value, 20_000);
  assert.equal(answered.purchaseTask?.budget.status, "limited");
  assert.equal(answered.purchaseTask?.budget.fen, 20_000);
});

test("declining budget lists related prices without inventing a main recommendation", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const first = (await agent.handleTurn("s", "budget1", "想买洗面奶")).result;
  assert.deepEqual(first.questionFields, ["skinType"]);
  await agent.handleTurn("s", "budget2", "偏油");
  const needBudget = (await agent.handleTurn("s", "budget3", "带香可以")).result;
  assert.deepEqual(needBudget.questionFields, ["budget"]);
  const listed = (await agent.handleTurn("s", "budget4", "预算还没想好，想先看看价格")).result;
  assert.equal(listed.action, "price_list");
  assert.deepEqual(listed.recommendations, []);
  assert.match(listed.reply, /¥169/);
  assert.match(listed.reply, /¥149/);
  assert.match(listed.reply, /预算可以晚点再定/);
  assert.equal(listed.purchaseTask?.budget.status, "declined");
});

test("gift-box ambiguity and a changed category create a fresh budget question", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const gift = (await agent.handleTurn("s", "gift1", "我想要礼盒")).result;
  assert.deepEqual(gift.questionFields, ["giftBoxType"]);
  assert.match(gift.questions[0], /旅行分装瓶礼盒/);
  const travel = (await agent.handleTurn("s", "gift2", "旅行分装那种")).result;
  assert.deepEqual(travel.questionFields, ["budget"]);
  assert.deepEqual(travel.purchaseTask?.goal.categories, ["travel"]);

  const switched = (await agent.handleTurn("s", "gift3", "现在改看保湿面霜")).result;
  assert.deepEqual(switched.questionFields, ["skinType"]);
  assert.deepEqual(switched.purchaseTask?.goal.categories, ["moisturizer"]);
  assert.deepEqual(switched.purchaseTask?.displayedSkus, []);
});

test("requesting another option never repeats a displayed SKU", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const first = (await agent.handleTurn("s", "alt1", "预算150，我是油皮，想买洗面奶")).result;
  assert.equal(first.action, "recommend");
  assert.deepEqual(first.purchaseTask?.displayedSkus, ["P102"]);
  const alternative = (await agent.handleTurn("s", "alt2", "还有其他推荐吗")).result;
  assert.equal(alternative.action, "unavailable");
  assert.deepEqual(alternative.recommendations, []);
  assert.match(alternative.reply, /已经展示完|没有适合直接推荐/);
  assert.deepEqual(alternative.purchaseTask?.displayedSkus, ["P102"]);
});

test("rejecting the current recommendation asks one reason then excludes that SKU", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const first = (await agent.handleTurn("s", "post-reject-1", "预算200，我是油皮，能接受香味，你帮我定一款洗面奶")).result;
  assert.equal(first.action, "recommend");
  assert.equal(first.purchaseTask?.currentRecommendation?.primarySku, "P102");

  const rejected = (await agent.handleTurn("s", "post-reject-2", "不合适")).result;
  assert.equal(rejected.action, "clarify");
  assert.deepEqual(rejected.questionFields, ["rejectionReason"]);
  assert.equal(rejected.questions.length, 1);
  assert.deepEqual(rejected.recommendations, []);
  assert.match(rejected.reply, /这款先排除/);
  assert.doesNotMatch(rejected.reply, /换一支|另一款|新推荐/);
  assert.deepEqual(rejected.purchaseTask?.rejectedSkus?.map((item) => item.sku), ["P102"]);
  assert.equal(rejected.purchaseTask?.decisionStage, "clarifying_rejection");

  const direction = (await agent.handleTurn("s", "post-reject-3", "想换个方向")).result;
  assert.equal(direction.recommendations.some((item) => item.sku === "P102"), false);
  assert.equal(direction.candidateSkus.includes("P102"), false);
});

test("accepting the current recommendation confirms selection instead of replaying an old decision", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  const first = (await agent.handleTurn("s", "post-accept-1", "预算200，我是油皮，能接受香味，你帮我定一款洗面奶")).result;
  const selected = (await agent.handleTurn("s", "post-accept-2", "合适")).result;
  assert.equal(selected.action, "selection_confirmed");
  assert.equal(selected.purchaseTask?.selectedSku, first.purchaseTask?.currentRecommendation?.primarySku);
  assert.equal(selected.purchaseTask?.decisionStage, "selected");
  assert.notEqual(selected.action, "price_list");
  assert.match(selected.reply, /就按这款/);
  assert.equal((selected.reply.match(/P102/g) ?? []).length, 1);
});

test("asking why or comparing products preserves the current goal without turning the SKU into a target", async () => {
  const repo = new MemoryRepository();
  const agent = runtime(repo);
  await agent.handleTurn("s", "post-explain-1", "预算200，我是油皮，能接受香味，你帮我定一款洗面奶");
  const explained = (await agent.handleTurn("s", "post-explain-2", "为什么不推荐 P101")).result;
  assert.equal(explained.action, "product_explanation");
  assert.deepEqual(explained.purchaseTask?.goal.categories, ["cleanser"]);
  assert.equal(explained.state.facts.targetSku, undefined);
  assert.equal(explained.purchaseTask?.currentRecommendation?.primarySku, "P102");
  assert.equal((explained.reply.match(/P101/g) ?? []).length, 1);
  assert.doesNotMatch(explained.reply, /换一支|另一款|新推荐/);

  const compared = (await agent.handleTurn("s", "post-explain-3", "P101 和 P102 比呢")).result;
  assert.equal(compared.action, "product_comparison");
  assert.deepEqual(new Set(compared.candidateSkus), new Set(["P101", "P102"]));
  assert.equal(compared.state.facts.targetSku, undefined);
  assert.equal((compared.reply.match(/P101/g) ?? []).length, 1);
  assert.equal((compared.reply.match(/P102/g) ?? []).length, 1);
});

test("a stale rejection reply cannot commit rejected or displayed product progress", async () => {
  const repo = new MemoryRepository();
  await runtime(repo).handleTurn("s", "stale-reject-1", "预算200，我是油皮，能接受香味，你帮我定一款洗面奶");
  const gate = deferred();
  const rejection = runtime(repo, { renderGate: gate }).handleTurn("s", "stale-reject-2", "不合适");
  await until(() => repo.session.appliedInputVersion === 2);
  const safety = await runtime(repo).handleTurn("s", "stale-reject-3", "我现在脸很疼");
  assert.equal(safety.result.action, "safety");
  gate.release();
  assert.equal((await rejection).stale, true);
  assert.equal(repo.session.result?.action, "safety");
  assert.deepEqual(repo.session.result?.purchaseTask?.rejectedSkus ?? [], []);
});
