import { applyReasoningProposal, decide, KNOWLEDGE_VERSION } from "./decision";
import { BailianModelAdapter } from "./model";
import { D1GuideRepository } from "./repository";
import { composeResult } from "./response";
import { applyDelta, deterministicExtract, mergeDeltas } from "./state";
import type { DecisionResult, ModelAudit } from "./types";

export class ConversationRuntime {
  constructor(
    private repository = new D1GuideRepository(),
    private model = new BailianModelAdapter(),
  ) {}

  async handleTurn(sessionId: string, requestId: string, text: string): Promise<{ result: DecisionResult; duplicate: boolean; stale: boolean }> {
    const begin = await this.repository.beginTurn(sessionId, requestId, text);
    if (begin.duplicate) {
      if (begin.response) return { result: begin.response, duplicate: true, stale: false };
      throw new Error(begin.processing ? "request_processing" : "duplicate_without_result");
    }

    const audits: ModelAudit[] = [];
    try {
      const extracted = await this.model.extract(text, begin.session.state);
      audits.push(extracted.audit);
      const localDelta = deterministicExtract(text);
      const delta = mergeDeltas(extracted.delta, localDelta);
      const state = applyDelta(begin.session.state, delta);

      const checkpoint = await this.repository.commitState(sessionId, begin.session.inputVersion, begin.session.stateVersion, state);
      if (!checkpoint) {
        const current = await this.repository.getSession(sessionId);
        const fallback = current?.result ?? composeResult({
          action: "unavailable", route: "degraded", routeReason: "检测到更新的用户输入，本轮迟到结果已丢弃", questionFields: [], candidateSkus: [], recommendations: [], productFits: [], evidence: [], limitations: ["请以最新一轮回复为准"],
        }, current?.state ?? state, audits, { input: current?.inputVersion ?? begin.session.inputVersion, state: current?.stateVersion ?? begin.session.stateVersion, knowledge: KNOWLEDGE_VERSION });
        await this.repository.failTurn(sessionId, requestId, fallback);
        return { result: fallback, duplicate: false, stale: true };
      }

      let draft = decide(checkpoint.state);
      if (draft.route === "reasoning") {
        const reasoned = await this.model.reason(checkpoint.state, draft);
        audits.push(...reasoned.audits);
        draft = applyReasoningProposal(draft, reasoned.proposal);
      }

      // Recompute from the current authoritative state before composing the response.
      const revalidated = decide(checkpoint.state);
      if (revalidated.action === "safety" || revalidated.action === "budget_conflict" || revalidated.action === "policy_unknown") draft = revalidated;
      const result = composeResult(draft, checkpoint.state, audits, { input: checkpoint.inputVersion, state: checkpoint.stateVersion, knowledge: KNOWLEDGE_VERSION });
      const committed = await this.repository.commitResult(sessionId, requestId, checkpoint.inputVersion, checkpoint.stateVersion, result);
      if (!committed) {
        const current = await this.repository.getSession(sessionId);
        const fallback = current?.result ?? { ...result, action: "unavailable" as const, route: "degraded" as const, routeReason: "出现更新的用户输入，本轮结果已失效", reply: "我收到了更新的信息，正在以最新内容重新判断。请以最新一轮回复为准。", recommendations: [] };
        return { result: fallback, duplicate: false, stale: true };
      }
      return { result, duplicate: false, stale: false };
    } catch (error) {
      const current = await this.repository.getSession(sessionId);
      const fallbackDraft = current ? decide(current.state) : null;
      const fallback = fallbackDraft && current ? composeResult(fallbackDraft, current.state, audits, { input: current.inputVersion, state: current.stateVersion, knowledge: KNOWLEDGE_VERSION }) : null;
      await this.repository.failTurn(sessionId, requestId, fallback);
      if (fallback) return { result: fallback, duplicate: false, stale: false };
      throw error;
    }
  }
}
