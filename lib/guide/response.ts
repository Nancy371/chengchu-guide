import { planConversation, renderTemplate, type ConversationPlan, type RenderedCopy } from "./conversation";
import type { DecisionDraft, DecisionResult, DecisionTrace, HabitMemory, LifestyleObservation, ModelAudit, StateField, TurnSignal, UserState } from "./types";

interface ComposeContext {
  signals?: TurnSignal[];
  lifestyle?: LifestyleObservation[];
  memories?: HabitMemory[];
  previousResult?: DecisionResult | null;
  updatedFields?: StateField[];
  plan?: ConversationPlan;
  rendered?: RenderedCopy | null;
  renderSource?: "model" | "template";
  renderFallbackReason?: string;
  decisionTrace?: DecisionTrace;
}

export function composeResult(
  draft: DecisionDraft,
  state: UserState,
  audits: ModelAudit[],
  versions: DecisionResult["versions"],
  context: ComposeContext = {},
): DecisionResult {
  const signals = context.signals ?? [];
  const lifestyle = context.lifestyle ?? [];
  const plan = context.plan ?? planConversation({
    draft,
    state,
    signals,
    lifestyle,
    memories: context.memories ?? [],
    previousResult: context.previousResult,
    updatedFields: context.updatedFields ?? [],
  });
  const fallback = renderTemplate(plan, signals);
  const copy = context.rendered ?? fallback;
  const finalDraft: DecisionDraft = plan.policy.nextAction === "close"
    ? { ...draft, action: "close", recommendations: [], candidateSkus: [], totalFen: undefined, budgetGapFen: undefined, routeReason: "用户明确表示停止推荐或暂不购买" }
    : { ...draft, questionFields: plan.policy.selectedQuestionFields };
  return {
    ...finalDraft,
    reply: copy.reply,
    questions: copy.questions,
    state,
    audits,
    turnSignals: signals,
    lifestyle,
    conversationPolicy: plan.policy,
    render: {
      source: context.rendered && context.renderSource === "model" ? "model" : "template",
      validationPassed: true,
      fallbackReason: context.rendered && context.renderSource === "model" ? undefined : context.renderFallbackReason,
      factBlockIds: copy.factBlockIds,
    },
    versions,
    ...(context.decisionTrace ? { decisionTrace: { ...context.decisionTrace, routeReason: finalDraft.routeReason } } : {}),
  };
}

export { formatMoney } from "./conversation";
