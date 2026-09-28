import { planConversation, renderTemplate } from "./conversation";
import { buildAgentContext, decisionTrace, withDecision } from "./agent-context";
import { decide, KNOWLEDGE_VERSION } from "./decision";
import { PRODUCTS_BY_SKU } from "./catalog";
import { authorizeFinalDecision, parseFinalProposal, safetyDecision } from "./final-decision";
import { prepareDeterministicCandidates, runPlannerLoop } from "./planner";
import { clarificationGoalKey, comparableFits, exhaustedLowRiskQuestion, matchingProgress, nextClarificationProgress } from "./clarification";
import { DeepSeekModelAdapter } from "./model";
import { D1GuideRepository } from "./repository";
import { composeResult } from "./response";
import { deterministicExtract, deterministicUnderstand, fact } from "./state";
import { verifiedState } from "./verified-state";
import { askPurchaseQuestion, completePurchaseTask, updatePurchaseTask } from "./purchase-task";
import type { AgentTrace, DecisionResult, FinalDecisionProposal, ModelAudit, SessionRecord, TurnUnderstanding } from "./types";

const PREDECESSOR_TIMEOUT_MS = 12_000;

function comparisonProposal(context: ReturnType<typeof buildAgentContext>, field: NonNullable<ReturnType<typeof exhaustedLowRiskQuestion>>): FinalDecisionProposal {
  const fits = comparableFits(context);
  return { kind: "comparison_only", field, skus: fits.map((fit) => fit.sku), evidenceIds: fits.flatMap((fit) => fit.evidence.map((item) => item.id)) };
}

function deterministicProposal(context: ReturnType<typeof buildAgentContext>, reason: string): FinalDecisionProposal {
  if (context.purchaseTask.goal.kind === "unsupported_skincare_gift_box") return { kind: "direct", source: "fallback", reason: "UNSUPPORTED_GIFT_BOX", action: "unavailable" };
  if (context.purchaseTask.budget.status === "declined") {
    const skus = context.candidateProducts.filter((fit) => context.purchaseTask.goal.categories.includes(PRODUCTS_BY_SKU[fit.sku]?.category)).map((fit) => fit.sku);
    return skus.length ? { kind: "price_list", skus, evidenceIds: skus.map((sku) => `catalog:${sku}`) } : { kind: "direct", source: "fallback", reason: "NO_RELATED_PRODUCTS", action: "unavailable" };
  }
  if (context.purchaseTask.turnAction.kind === "request_alternative" && !context.productFits.some((fit) => fit.status === "eligible")) return { kind: "direct", source: "fallback", reason: "NO_NEW_ALTERNATIVE", action: "unavailable" };
  const unresolved = context.requiredMissingFields[0];
  const exhausted = exhaustedLowRiskQuestion(context);
  if (exhausted && comparableFits(context).length === 2) return comparisonProposal(context, exhausted);
  if (exhausted) return { kind: "direct", source: "fallback", reason: "LOW_RISK_UNRESOLVED", action: "unavailable" };
  if (unresolved) return { kind: "ask", field: unresolved, questionGoal: "确认会改变当前选择的必要信息", evidenceGap: "当前回答尚不能确定该字段" };
  const eligible = context.productFits.filter((fit) => fit.status === "eligible").sort((a, b) => b.score - a.score);
  if (context.goal.categories.length <= 1 && eligible.length && (eligible.length === 1 || fact<boolean>(context.userState as SessionRecord["state"], "delegateChoice") === true)) {
    return { kind: "recommend", skus: [eligible[0].sku], evidenceIds: eligible[0].evidence.map((item) => item.id), relation: "single" };
  }
  return { kind: "direct", source: "fallback", reason };
}

function staleResult(session: SessionRecord): DecisionResult {
  const result = composeResult({
    action: "unavailable", route: "degraded", routeReason: "本轮回复已失效", questionFields: [],
    candidateSkus: [], recommendations: [], productFits: [], evidence: [], limitations: ["请以最新输入的回复为准"],
  }, session.state, [], { input: session.inputVersion, state: session.stateVersion, knowledge: KNOWLEDGE_VERSION },
  { signals: [], lifestyle: [], updatedFields: [], renderFallbackReason: "stale_input" });
  return { ...result, reply: "已收到更新的消息，前一条建议先别看；我会按最新信息重新判断。", recommendations: [], ...(session.result?.purchaseTask ?? session.state.purchaseTask ? { purchaseTask: session.result?.purchaseTask ?? session.state.purchaseTask } : {}) };
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
        const priorTask = current.result?.purchaseTask ?? current.state.purchaseTask;
        const verified = await verifiedState.update({ currentState: current.state, userMessage: pending.text, pendingQuestion: priorTask?.pendingQuestion?.field });
        const purchaseTask = updatePurchaseTask({ previous: priorTask, previousState: current.state, currentState: verified.state, understanding: verified.understanding, userMessage: pending.text });
        const recovered = await this.repository.commitState(sessionId, current.appliedInputVersion + 1, current.stateVersion, { ...verified.state, purchaseTask });
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
    let understanding: TurnUnderstanding = deterministicUnderstand(text, begin.previousResult?.purchaseTask?.pendingQuestion?.field ?? begin.previousResult?.clarification?.field ?? begin.previousResult?.questionFields[0]);
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
      const previousResult = predecessor.result?.versions.state === predecessor.stateVersion ? predecessor.result : begin.previousResult?.versions.state === predecessor.stateVersion ? begin.previousResult : null;
      const nextCategory = deterministicExtract(text).updates.find((item) => item.field === "categories")?.value;
      const categoryChanged = Array.isArray(nextCategory) && JSON.stringify(nextCategory) !== JSON.stringify(predecessor.state.facts.categories?.value);
      const pendingQuestion = categoryChanged ? undefined : previousResult?.purchaseTask?.pendingQuestion?.field ?? previousResult?.clarification?.field ?? previousResult?.questionFields[0];
      const verified = await verifiedState.update({ currentState: predecessor.state, userMessage: text, pendingQuestion,
        extract: (message, state, pendingQuestion) => this.model.extract(message, state, pendingQuestion) });
      if (verified.audit.model) audits.push(verified.audit.model);
      understanding = verified.understanding;
      const purchaseTask = updatePurchaseTask({ previous: previousResult?.purchaseTask ?? predecessor.state.purchaseTask, previousState: predecessor.state, currentState: verified.state, understanding, userMessage: text });
      const state = { ...verified.state, purchaseTask };
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
      let agentContext = buildAgentContext({ session: checkpoint, memories: memoryProfile.memories, memoryVersion: memoryProfile.version, previousResult });
      const deterministic = agentContext.hardConstraints.safety === "active_risk"
        ? safetyDecision(agentContext.userState as SessionRecord["state"])
        : decide(agentContext.userState as SessionRecord["state"], memoryProfile.memories);
      const deadlineAt = startedAt + (["safety", "price_answer", "policy_unknown", "budget_conflict", "unavailable"].includes(deterministic.action) ? 20_000 : 40_000);
      const plannerTrace: AgentTrace["planner"] = [];
      let fallbackReason: string | undefined;
      let reasonerProposal: AgentTrace["reasonerProposal"];
      const reject = understanding.signals.some((signal) => signal.value === "reject" && signal.subject !== "other" && signal.temporal !== "historical");
      const declinedAnswer = understanding.signals.some((signal) => signal.value === "decline_answer" && signal.subject === "self" && signal.temporal !== "historical");
      let proposal: FinalDecisionProposal | null = null;
      if (declinedAnswer && pendingQuestion && agentContext.hardConstraints.safety === "unclear") {
        agentContext = { ...agentContext, requiredMissingFields: ["currentDiscomfort"] };
        proposal = { kind: "direct", source: "rule", reason: "USER_DECLINED_SAFETY_QUESTION", action: "unavailable" };
      } else if (declinedAnswer && pendingQuestion && agentContext.hardConstraints.safety !== "active_risk") {
        agentContext = prepareDeterministicCandidates(agentContext);
        if (agentContext.requiredMissingFields.includes(pendingQuestion)) {
          proposal = comparableFits(agentContext).length === 2 && agentContext.requiredMissingFields.length === 1
            ? comparisonProposal(agentContext, pendingQuestion)
            : { kind: "direct", source: "rule", reason: "USER_DECLINED_REQUIRED_QUESTION", action: "unavailable" };
        }
      }
      if (proposal) {
        fallbackReason = "USER_DECLINED_REQUIRED_QUESTION";
      } else if (deterministic.action === "safety" || reject || ["price_answer", "policy_unknown", "budget_conflict", "unavailable"].includes(deterministic.action) || agentContext.hardConstraints.safety === "unclear") {
        agentContext = { ...agentContext, observations: [{ order: 1, tool: "check_safety", outcome: agentContext.hardConstraints.safety }], completedActions: ["check_safety"] };
        proposal = { kind: "direct", source: "rule", reason: reject ? "USER_REJECTED" : deterministic.routeReason, ...(reject && deterministic.action !== "safety" ? { action: "close" as const } : {}) };
      } else if (agentContext.purchaseTask.goal.kind === "unsupported_skincare_gift_box") {
        proposal = { kind: "direct", source: "rule", reason: "UNSUPPORTED_GIFT_BOX", action: "unavailable" };
      } else if (agentContext.purchaseTask.budget.status === "declined") {
        agentContext = prepareDeterministicCandidates(agentContext);
        proposal = deterministicProposal(agentContext, "BUDGET_DECLINED");
      } else {
        const loop = await runPlannerLoop(agentContext, this.model, deadlineAt);
        agentContext = loop.context;
        plannerTrace.push(...loop.trace);
        audits.push(...loop.audits);
        fallbackReason = loop.fallbackReason;
        if (loop.questionField) {
          proposal = { kind: "ask", field: loop.questionField, questionGoal: "确认会改变当前选择的必要信息", evidenceGap: "当前回答尚不能确定该字段" };
        } else if (loop.comparisonField) {
          proposal = comparisonProposal(agentContext, loop.comparisonField);
        } else if (!fallbackReason) {
          try {
            const reasoned = await this.model.finalDecision(agentContext, Math.min(16_000, Math.max(0, deadlineAt - Date.now() - 10_000)));
            audits.push(reasoned.audit);
            proposal = parseFinalProposal(reasoned.proposal);
            if (proposal?.kind === "direct") proposal = null;
            if (proposal?.kind === "recommend" || proposal?.kind === "ask") reasonerProposal = proposal;
            if (!proposal) fallbackReason = reasoned.audit.failureReason ?? "INVALID_REASONER_PROPOSAL";
          } catch {
            fallbackReason = "REASONER_EXCEPTION";
          }
        }
      }
      if (!proposal) {
        if (agentContext.hardConstraints.safety !== "active_risk" && agentContext.hardConstraints.safety !== "unclear") {
          agentContext = prepareDeterministicCandidates(buildAgentContext({ session: checkpoint, memories: memoryProfile.memories, memoryVersion: memoryProfile.version, previousResult }));
          proposal = deterministicProposal(agentContext, fallbackReason ?? "MODEL_UNAVAILABLE");
        }
        if (!proposal) proposal = { kind: "direct", source: "fallback", reason: fallbackReason ?? "MODEL_UNAVAILABLE" };
      }
      const latest = await this.repository.getSession(sessionId, userId);
      if (!latest) throw new Error("session_not_found");
      const liveMemory = userId ? await this.repository.getMemoryProfile(userId) : memoryProfile;
      let authorization = authorizeFinalDecision({ proposal, context: agentContext, current: { input: latest.appliedInputVersion, state: latest.stateVersion, knowledge: KNOWLEDGE_VERSION, memory: liveMemory.version }, signals: understanding.signals });
      if (authorization.status === "STALE" && latest.appliedInputVersion === begin.inputVersion && liveMemory.version !== agentContext.habits.version) {
        agentContext = buildAgentContext({ session: latest, memories: liveMemory.memories, memoryVersion: liveMemory.version, previousResult });
        fallbackReason = "MEMORY_VERSION_CHANGED";
        proposal = { kind: "direct", source: "fallback", reason: fallbackReason };
        authorization = authorizeFinalDecision({ proposal, context: agentContext, current: { input: latest.appliedInputVersion, state: latest.stateVersion, knowledge: KNOWLEDGE_VERSION, memory: liveMemory.version }, signals: understanding.signals });
      }
      if (authorization.status === "STALE") {
        const stale = staleResult(latest);
        await this.repository.failTurn(sessionId, requestId, stale);
        return { result: stale, duplicate: false, stale: true };
      }
      if (authorization.status !== "APPROVED" || !authorization.decision) {
        fallbackReason = authorization.reason;
        proposal = deterministicProposal(agentContext, fallbackReason);
        authorization = authorizeFinalDecision({ proposal, context: agentContext, current: { input: latest.appliedInputVersion, state: latest.stateVersion, knowledge: KNOWLEDGE_VERSION, memory: liveMemory.version }, signals: understanding.signals });
      }
      if (authorization.status !== "APPROVED" || !authorization.decision) throw new Error(`final_authorization_${authorization.reason}`);
      const reasonAuditIndex = audits.findLastIndex((audit) => audit.stage === "reason");
      if (reasonAuditIndex >= 0) audits[reasonAuditIndex] = { ...audits[reasonAuditIndex], schemaSuccess: reasonerProposal !== undefined, businessAccepted: reasonerProposal !== undefined && !fallbackReason, used: reasonerProposal !== undefined && !fallbackReason };
      const draft = authorization.decision;
      agentContext = withDecision(agentContext, draft);
      const agentTrace: AgentTrace = { planner: plannerTrace, observations: agentContext.observations.map(({ order, tool, outcome }) => ({ order, tool, outcome })), ...(reasonerProposal ? { reasonerProposal } : {}), authorization: authorization.status, authorizationReason: authorization.reason, ...(fallbackReason ? { fallbackReason } : {}), versions: agentContext.versions };

      const plan = planConversation({
        draft,
        state: checkpoint.state,
        signals: understanding.signals,
        lifestyle: understanding.lifestyle,
        memories: liveMemory.memories,
        previousResult,
        updatedFields,
        questionAttempt: draft.questionFields[0] ? (matchingProgress(agentContext, draft.questionFields[0])?.askedCount ?? 0) + 1 : undefined,
      });
      let rendered = null;
      let renderFallbackReason: string | undefined;
      if (plan.policy.nextAction === "safety" || plan.policy.nextAction === "close" || plan.policy.nextAction === "clarify" || understanding.signals.some((item) => item.value === "answer_ambiguous" && item.subject === "self")) {
        rendered = renderTemplate(plan, understanding.signals);
        renderFallbackReason = plan.policy.nextAction === "safety" || plan.policy.nextAction === "close" ? "deterministic_safety_or_close" : plan.policy.nextAction === "clarify" ? "single_question_template" : "contextual_ambiguity_followup";
      } else {
        const renderResult = await this.model.render(plan, deadlineAt - Date.now());
        if (renderResult.copy) {
          try {
            const review = await this.model.reviewRender(plan, renderResult.copy, deadlineAt - Date.now());
            audits.push({ ...renderResult.audit, used: review.approved });
            audits.push(review.audit);
            rendered = review.approved ? renderResult.copy : null;
            renderFallbackReason = review.approved ? undefined : review.audit.failureReason ?? "render_review_rejected";
          } catch {
            audits.push({ ...renderResult.audit, used: false, businessAccepted: false });
            audits.push({ stage: "render_review", model: "configured-reviewer", modelInvoked: true, parseSuccess: false, schemaSuccess: false, businessAccepted: false, used: false, latencyMs: 0, failureReason: "render_review_exception" });
            rendered = null;
            renderFallbackReason = "render_review_exception";
          }
        } else {
          audits.push(renderResult.audit);
          renderFallbackReason = renderResult.audit.failureReason ?? "render_unavailable";
        }
      }

      const composed = composeResult(draft, checkpoint.state, audits, {
        input: begin.inputVersion,
        state: checkpoint.stateVersion,
        knowledge: KNOWLEDGE_VERSION,
      }, {
        signals: understanding.signals,
        lifestyle: understanding.lifestyle,
        memories: liveMemory.memories,
        previousResult,
        updatedFields,
        plan,
        rendered,
        renderSource: rendered && !renderFallbackReason ? "model" : "template",
        renderFallbackReason,
        decisionTrace: decisionTrace(agentContext),
        agentTrace,
      });
      const askedField = composed.questionFields[0];
      const clarification = askedField ? nextClarificationProgress(agentContext, askedField, draft.routeReason)
        : ["price_answer", "policy_unknown", "comparison_only"].includes(composed.action) && agentContext.clarification?.goalKey === clarificationGoalKey(checkpoint.state)
          ? agentContext.clarification : undefined;
      const taskWithQuestion = askedField ? askPurchaseQuestion(agentContext.purchaseTask as typeof purchaseTask, askedField, draft.routeReason) : agentContext.purchaseTask as typeof purchaseTask;
      const completedTask = completePurchaseTask(taskWithQuestion, composed);
      const result = { ...composed, ...(clarification ? { clarification } : {}), purchaseTask: completedTask };
      const committed = await this.repository.commitResult(sessionId, requestId, begin.inputVersion, checkpoint.stateVersion, result);
      if (!committed) {
        const current = await this.repository.getSession(sessionId, userId);
        if (!current) throw new Error("session_not_found");
        const stale = staleResult(current);
        await this.repository.failTurn(sessionId, requestId, stale);
        return { result: stale, duplicate: false, stale: true };
      }

      if (userId && liveMemory.enabled) {
        try {
          await this.repository.saveHabitObservations({
            userId,
            sessionId,
            inputVersion: begin.inputVersion,
            stateVersion: checkpoint.stateVersion,
            settingsVersion: liveMemory.version,
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
        const priorTask = current.result?.purchaseTask ?? begin.previousResult?.purchaseTask ?? current.state.purchaseTask;
        const verified = await verifiedState.update({ currentState: current.state, userMessage: text, pendingQuestion: priorTask?.pendingQuestion?.field ?? begin.previousResult?.questionFields[0] });
        understanding = verified.understanding;
        const purchaseTask = updatePurchaseTask({ previous: priorTask, previousState: current.state, currentState: verified.state, understanding, userMessage: text });
        checkpoint = await this.repository.commitState(sessionId, begin.inputVersion, current.stateVersion, { ...verified.state, purchaseTask });
      }
      const latest = await this.repository.getSession(sessionId, userId);
      if (checkpoint && latest?.inputVersion === begin.inputVersion && latest.appliedInputVersion === begin.inputVersion) {
        const latestMemory = userId ? await this.repository.getMemoryProfile(userId) : { version: 0, memories: [] };
        const fallbackContext = buildAgentContext({ session: latest, memories: latestMemory.memories, memoryVersion: latestMemory.version });
        const authorized = authorizeFinalDecision({ proposal: { kind: "direct", source: "fallback", reason: "RUNTIME_EXCEPTION" }, context: fallbackContext, current: { input: latest.appliedInputVersion, state: latest.stateVersion, knowledge: KNOWLEDGE_VERSION, memory: latestMemory.version }, signals: understanding.signals });
        if (authorized.status !== "APPROVED" || !authorized.decision) throw error;
        const fallbackComposed = composeResult(authorized.decision, checkpoint.state, audits,
          { input: begin.inputVersion, state: checkpoint.stateVersion, knowledge: KNOWLEDGE_VERSION },
          { signals: understanding.signals, lifestyle: understanding.lifestyle, previousResult: begin.previousResult,
            updatedFields: understanding.delta.updates.map((item) => item.field), renderFallbackReason: "runtime_fallback", decisionTrace: decisionTrace(withDecision(fallbackContext, authorized.decision)),
            agentTrace: { planner: [], observations: [], authorization: authorized.status, authorizationReason: authorized.reason, fallbackReason: "RUNTIME_EXCEPTION", versions: fallbackContext.versions } });
        const fallbackTask = completePurchaseTask(fallbackContext.purchaseTask, fallbackComposed);
        const fallback = { ...fallbackComposed, purchaseTask: fallbackTask };
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
