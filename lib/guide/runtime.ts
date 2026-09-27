import { planConversation, renderTemplate } from "./conversation";
import { applyReasoningProposal, decide, KNOWLEDGE_VERSION } from "./decision";
import { DeepSeekModelAdapter } from "./model";
import { D1GuideRepository } from "./repository";
import { composeResult } from "./response";
import { applyDelta, deterministicUnderstand, mergeUnderstanding } from "./state";
import type { DecisionResult, ModelAudit, TurnUnderstanding } from "./types";

export class ConversationRuntime {
  constructor(
    private repository = new D1GuideRepository(),
    private model = new DeepSeekModelAdapter(),
  ) {}

  async handleTurn(sessionId: string, requestId: string, text: string, userId: string | null = null): Promise<{ result: DecisionResult; duplicate: boolean; stale: boolean }> {
    const startedAt = Date.now();
    const begin = await this.repository.beginTurn(sessionId, requestId, text, userId);
    if (begin.duplicate) {
      if (begin.response) return { result: begin.response, duplicate: true, stale: false };
      throw new Error(begin.processing ? "request_processing" : "duplicate_without_result");
    }

    const audits: ModelAudit[] = [];
    let understanding: TurnUnderstanding = deterministicUnderstand(text);
    try {
      const extracted = await this.model.extract(text, begin.session.state);
      audits.push(extracted.audit);
      understanding = mergeUnderstanding(extracted.understanding, understanding);
      const state = applyDelta(begin.session.state, understanding.delta);
      const updatedFields = understanding.delta.updates.map((item) => item.field);

      const checkpoint = await this.repository.commitState(sessionId, begin.session.inputVersion, begin.session.stateVersion, state);
      if (!checkpoint) {
        const current = await this.repository.getSession(sessionId, userId);
        const fallback = current?.result ?? composeResult({
          action: "unavailable", route: "degraded", routeReason: "检测到更新的用户输入，本轮迟到结果已丢弃", questionFields: [], candidateSkus: [], recommendations: [], productFits: [], evidence: [], limitations: ["请以最新一轮回复为准"],
        }, current?.state ?? state, audits, { input: current?.inputVersion ?? begin.session.inputVersion, state: current?.stateVersion ?? begin.session.stateVersion, knowledge: KNOWLEDGE_VERSION }, {
          signals: understanding.signals,
          lifestyle: understanding.lifestyle,
          previousResult: begin.previousResult,
          updatedFields,
          renderFallbackReason: "stale_state",
        });
        await this.repository.failTurn(sessionId, requestId, fallback);
        return { result: fallback, duplicate: false, stale: true };
      }

      const memoryProfile = userId
        ? await this.repository.getMemoryProfile(userId)
        : { enabled: false, version: 0, memories: [] };
      let draft = decide(checkpoint.state, memoryProfile.memories);
      const deadlineAt = startedAt + (draft.route === "reasoning" ? 40_000 : 20_000);
      if (draft.route === "reasoning") {
        const reasoned = await this.model.reason(checkpoint.state, draft, deadlineAt);
        audits.push(...reasoned.audits);
        draft = applyReasoningProposal(draft, reasoned.proposal, checkpoint.state);
      }

      const revalidated = decide(checkpoint.state, memoryProfile.memories);
      if (["safety", "budget_conflict", "policy_unknown", "close"].includes(revalidated.action)) draft = revalidated;

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
        audits.push(renderResult.audit);
        rendered = renderResult.copy;
        renderFallbackReason = renderResult.copy ? undefined : renderResult.audit.failureReason ?? "render_unavailable";
      }

      const result = composeResult(draft, checkpoint.state, audits, {
        input: checkpoint.inputVersion,
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
      });
      const committed = await this.repository.commitResult(sessionId, requestId, checkpoint.inputVersion, checkpoint.stateVersion, result);
      if (!committed) {
        const current = await this.repository.getSession(sessionId, userId);
        const fallback = current?.result ?? { ...result, action: "unavailable" as const, route: "degraded" as const, routeReason: "出现更新的用户输入，本轮结果已失效", reply: "我收到了更新的信息，正在以最新内容重新判断。请以最新一轮回复为准。", recommendations: [] };
        return { result: fallback, duplicate: false, stale: true };
      }

      if (userId && memoryProfile.enabled) {
        try {
          await this.repository.saveHabitObservations({
            userId,
            sessionId,
            inputVersion: checkpoint.inputVersion,
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
      const memories = userId ? (await this.repository.getMemoryProfile(userId).catch(() => ({ enabled: false, version: 0, memories: [] }))).memories : [];
      const hasImmediateSafetyUpdate = understanding.delta.updates.some((item) => item.field === "currentDiscomfort" && item.value === true);
      const fallbackState = current && hasImmediateSafetyUpdate && current.state.turn <= begin.session.state.turn
        ? applyDelta(current.state, understanding.delta)
        : current?.state;
      const fallbackDraft = fallbackState ? decide(fallbackState, memories) : null;
      const fallback = fallbackDraft && current && fallbackState ? composeResult(fallbackDraft, fallbackState, audits, { input: current.inputVersion, state: current.stateVersion, knowledge: KNOWLEDGE_VERSION }, {
        signals: understanding.signals,
        lifestyle: understanding.lifestyle,
        memories,
        previousResult: begin.previousResult,
        updatedFields: understanding.delta.updates.map((item) => item.field),
        renderFallbackReason: "runtime_fallback",
      }) : null;
      await this.repository.failTurn(sessionId, requestId, fallback);
      if (fallback) return { result: fallback, duplicate: false, stale: false };
      throw error;
    }
  }
}
