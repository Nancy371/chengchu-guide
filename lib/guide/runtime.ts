import { planConversation, renderTemplate } from "./conversation";
import { buildAgentContext, decideWithContext, decisionTrace, withDecision } from "./agent-context";
import { applyReasoningProposal, KNOWLEDGE_VERSION } from "./decision";
import { DeepSeekModelAdapter } from "./model";
import { D1GuideRepository } from "./repository";
import { composeResult } from "./response";
import { deterministicUnderstand } from "./state";
import { verifiedState } from "./verified-state";
import type { DecisionResult, ModelAudit, SessionRecord, TurnUnderstanding } from "./types";

const PREDECESSOR_TIMEOUT_MS = 12_000;

function staleResult(session: SessionRecord): DecisionResult {
  const result = composeResult({
    action: "unavailable", route: "degraded", routeReason: "本轮回复已失效", questionFields: [],
    candidateSkus: [], recommendations: [], productFits: [], evidence: [], limitations: ["请以最新输入的回复为准"],
  }, session.state, [], { input: session.inputVersion, state: session.stateVersion, knowledge: KNOWLEDGE_VERSION },
  { signals: [], lifestyle: [], updatedFields: [], renderFallbackReason: "stale_input" });
  return { ...result, reply: "已收到更新的消息，前一条建议先别看；我会按最新信息重新判断。", recommendations: [] };
}

export class ConversationRuntime {
  constructor(
    private repository = new D1GuideRepository(),
    private model = new DeepSeekModelAdapter(),
  ) {}

  private async awaitPredecessors(sessionId: string, inputVersion: number, userId: string | null): Promise<SessionRecord | null> {
    for (;;) {
      const current = await this.repository.getSession(sessionId, userId);
      if (!current || current.appliedInputVersion >= inputVersion) return null;
      if (current.appliedInputVersion === inputVersion - 1) return current;
      const pending = await this.repository.getPendingInput(sessionId, current.appliedInputVersion + 1, userId);
      if (!pending) throw new Error("pending_input_missing");
      if (Date.now() >= pending.created_at + PREDECESSOR_TIMEOUT_MS) {
        const verified = await verifiedState.update({ currentState: current.state, userMessage: pending.text });
        const recovered = await this.repository.commitState(sessionId, current.appliedInputVersion + 1, current.stateVersion, verified.state);
        if (recovered) await this.repository.failTurn(sessionId, pending.request_id, staleResult(recovered));
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  async handleTurn(sessionId: string, requestId: string, text: string, userId: string | null = null): Promise<{ result: DecisionResult; duplicate: boolean; stale: boolean }> {
    const begin = await this.repository.beginTurn(sessionId, requestId, text, userId);
    if (begin.duplicate) {
      if (begin.inputVersion < begin.session.inputVersion) return { result: staleResult(begin.session), duplicate: true, stale: true };
      if (begin.response) return { result: begin.response, duplicate: true, stale: false };
      throw new Error(begin.processing ? "request_processing" : "duplicate_without_result");
    }

    const audits: ModelAudit[] = [];
    let understanding: TurnUnderstanding = deterministicUnderstand(text, begin.previousResult?.questionFields[0]);
    let checkpoint: SessionRecord | null = null;
    try {
      const predecessor = await this.awaitPredecessors(sessionId, begin.inputVersion, userId);
      if (!predecessor) {
        const current = await this.repository.getSession(sessionId, userId);
        if (!current) throw new Error("session_not_found");
        const stale = staleResult(current);
        await this.repository.failTurn(sessionId, requestId, stale);
        return { result: stale, duplicate: false, stale: true };
      }
      const startedAt = Date.now();
      const verified = await verifiedState.update({ currentState: predecessor.state, userMessage: text, pendingQuestion: begin.previousResult?.questionFields[0],
        extract: (message, state) => this.model.extract(message, state) });
      if (verified.audit.model) audits.push(verified.audit.model);
      understanding = verified.understanding;
      const state = verified.state;
      const updatedFields = verified.audit.updatedFields;

      checkpoint = await this.repository.commitState(sessionId, begin.inputVersion, predecessor.stateVersion, state);
      if (!checkpoint) {
        const current = await this.repository.getSession(sessionId, userId);
        if (!current) throw new Error("session_not_found");
        const stale = staleResult(current);
        await this.repository.failTurn(sessionId, requestId, stale);
        return { result: stale, duplicate: false, stale: true };
      }

      const memoryProfile = userId
        ? await this.repository.getMemoryProfile(userId)
        : { enabled: false, version: 0, memories: [] };
      let agentContext = decideWithContext(buildAgentContext({ session: checkpoint, memories: memoryProfile.memories, memoryVersion: memoryProfile.version }));
      let draft = agentContext.currentDecision!;
      const deadlineAt = startedAt + (draft.route === "reasoning" ? 40_000 : 20_000);
      if (draft.route === "reasoning") {
        const reasoned = await this.model.reason(agentContext, deadlineAt);
        audits.push(...reasoned.audits);
        draft = applyReasoningProposal(draft, reasoned.proposal, checkpoint.state);
        agentContext = withDecision(agentContext, draft);
      }

      agentContext = decideWithContext(agentContext);
      const revalidated = agentContext.currentDecision!;
      if (["safety", "budget_conflict", "policy_unknown", "close"].includes(revalidated.action)) draft = revalidated;
      agentContext = withDecision(agentContext, draft);

      const plan = planConversation({
        draft,
        state: checkpoint.state,
        signals: understanding.signals,
        lifestyle: understanding.lifestyle,
        memories: memoryProfile.memories,
        previousResult: begin.previousResult,
        updatedFields,
      });
      let rendered = null;
      let renderFallbackReason: string | undefined;
      if (plan.policy.nextAction === "safety" || plan.policy.nextAction === "close") {
        rendered = renderTemplate(plan, understanding.signals);
        renderFallbackReason = "deterministic_safety_or_close";
      } else {
        const renderResult = await this.model.render(plan, deadlineAt - Date.now());
        if (renderResult.copy) {
          const review = await this.model.reviewRender(plan, renderResult.copy, deadlineAt - Date.now());
          audits.push({ ...renderResult.audit, used: review.approved });
          audits.push(review.audit);
          rendered = review.approved ? renderResult.copy : null;
          renderFallbackReason = review.approved ? undefined : review.audit.failureReason ?? "render_review_rejected";
        } else {
          audits.push(renderResult.audit);
          renderFallbackReason = renderResult.audit.failureReason ?? "render_unavailable";
        }
      }

      const result = composeResult(draft, checkpoint.state, audits, {
        input: begin.inputVersion,
        state: checkpoint.stateVersion,
        knowledge: KNOWLEDGE_VERSION,
      }, {
        signals: understanding.signals,
        lifestyle: understanding.lifestyle,
        memories: memoryProfile.memories,
        previousResult: begin.previousResult,
        updatedFields,
        plan,
        rendered,
        renderSource: rendered && !renderFallbackReason ? "model" : "template",
        renderFallbackReason,
        decisionTrace: decisionTrace(agentContext),
      });
      const committed = await this.repository.commitResult(sessionId, requestId, begin.inputVersion, checkpoint.stateVersion, result);
      if (!committed) {
        const current = await this.repository.getSession(sessionId, userId);
        if (!current) throw new Error("session_not_found");
        const stale = staleResult(current);
        await this.repository.failTurn(sessionId, requestId, stale);
        return { result: stale, duplicate: false, stale: true };
      }

      if (userId && memoryProfile.enabled) {
        try {
          await this.repository.saveHabitObservations({
            userId,
            sessionId,
            inputVersion: begin.inputVersion,
            stateVersion: checkpoint.stateVersion,
            settingsVersion: memoryProfile.version,
            turn: checkpoint.state.turn,
            observations: understanding.lifestyle,
          });
        } catch {
          // Preference persistence is optional and must never block the consultation.
        }
      }
      return { result, duplicate: false, stale: false };
    } catch (error) {
      const current = await this.repository.getSession(sessionId, userId);
      if (current?.appliedInputVersion === begin.inputVersion - 1) {
        const verified = await verifiedState.update({ currentState: current.state, userMessage: text, pendingQuestion: begin.previousResult?.questionFields[0] });
        understanding = verified.understanding;
        checkpoint = await this.repository.commitState(sessionId, begin.inputVersion, current.stateVersion, verified.state);
      }
      const latest = await this.repository.getSession(sessionId, userId);
      if (checkpoint && latest?.inputVersion === begin.inputVersion && latest.appliedInputVersion === begin.inputVersion) {
        const fallbackContext = decideWithContext(buildAgentContext({ session: checkpoint }));
        const fallback = composeResult(fallbackContext.currentDecision!, checkpoint.state, audits,
          { input: begin.inputVersion, state: checkpoint.stateVersion, knowledge: KNOWLEDGE_VERSION },
          { signals: understanding.signals, lifestyle: understanding.lifestyle, previousResult: begin.previousResult,
            updatedFields: understanding.delta.updates.map((item) => item.field), renderFallbackReason: "runtime_fallback", decisionTrace: decisionTrace(fallbackContext) });
        if (await this.repository.commitResult(sessionId, requestId, begin.inputVersion, checkpoint.stateVersion, fallback)) {
          return { result: fallback, duplicate: false, stale: false };
        }
      }
      if (latest) {
        const stale = staleResult(latest);
        await this.repository.failTurn(sessionId, requestId, stale);
        return { result: stale, duplicate: false, stale: true };
      }
      throw error;
    }
  }
}
