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

function runtime(repo: MemoryRepository, options: { renderGate?: ReturnType<typeof deferred>; extractGate?: ReturnType<typeof deferred>; plannerGate?: ReturnType<typeof deferred>; reasonerGate?: ReturnType<typeof deferred>; plannerActions?: unknown[]; reasonerProposal?: unknown; rejectedRender?: boolean; reviewThrows?: boolean } = {}) {
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
  assert.equal(repo.session.state.facts.targetSku?.value, "P101");
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
  const first = (await agent.handleTurn("s", "r1", "想买果酸，用过果酸，现在状态稳定")).result;
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
  const result = (await agent.handleTurn("s", "r1", "我是干皮，预算200，想买洗面奶")).result;
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
    const old = agent.handleTurn("s", "r1", "我是干皮，预算200，想买洗面奶");
    await until(() => repo.session.appliedInputVersion === 1);
    const newer = await agent.handleTurn("s", "r2", "现在脸很疼");
    assert.equal(newer.result.action, "safety");
    gate.release();
    assert.equal((await old).stale, true, blockedStage);
    assert.equal(repo.session.result?.action, "safety");
    assert.equal(repo.session.state.facts.pain?.value, true);
  }
});
