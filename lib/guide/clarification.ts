import { activeCategories } from "./tools";
import { PRODUCTS_BY_SKU } from "./catalog";
import { decide } from "./decision";
import { evaluateCandidates, LOW_RISK_FIELDS, MAX_LOW_RISK_QUESTIONS } from "./candidate-evaluation";
import { fact } from "./state";
import type { AgentContext, ClarificationProgress, DecisionDraft, ProductFit, PurchaseTask, StateField, UserState } from "./types";

export { MAX_LOW_RISK_QUESTIONS, LOW_RISK_FIELDS };

export function clarificationGoalKey(state: UserState, task?: PurchaseTask): string {
  const activeTask = task ?? state.purchaseTask;
  const categories = activeCategories(state).slice().sort();
  const explicitCategories = fact<string[]>(state, "categories") ?? [];
  return JSON.stringify({ taskGoal: activeTask?.goal.key ?? "legacy", goalVersion: activeTask?.goal.version ?? 0, categories, targetSku: explicitCategories.length ? null : fact<string>(state, "targetSku") ?? null, budgetStatus: activeTask?.budget.status ?? (fact<number>(state, "budget") === undefined ? "unknown" : "limited"), budget: activeTask?.budget.fen ?? fact<number>(state, "budget") ?? null });
}

export function clarificationCandidateKey(fits: ReadonlyArray<ProductFit>): string {
  return fits.filter((fit) => fit.status === "eligible" && fit.hardConstraintMatch !== false && fit.budgetStatus !== "over").map((fit) => fit.sku).sort().join("+");
}

export function requiredInformation(context: AgentContext, baseline: DecisionDraft = decide(context.userState as UserState, [...context.habits.relevant])): StateField[] {
  void baseline;
  const field = evaluateCandidates(context).selectedQuestion;
  return field ? [field] : [];
}

export function matchingProgress(context: AgentContext, field: StateField): ClarificationProgress | undefined {
  const savedCount = context.purchaseTask.questionCounts?.[field];
  if (savedCount) return {
    goalKey: clarificationGoalKey(context.userState as UserState, context.purchaseTask),
    candidateKey: clarificationCandidateKey(context.productFits),
    field,
    askedCount: savedCount,
    reason: context.purchaseTask.pendingQuestion?.field === field ? context.purchaseTask.pendingQuestion.reason : "此前已问过该必要信息",
  };
  if (context.purchaseTask.pendingQuestion?.field === field) {
    return {
      goalKey: clarificationGoalKey(context.userState as UserState, context.purchaseTask),
      candidateKey: clarificationCandidateKey(context.productFits),
      field,
      askedCount: context.purchaseTask.pendingQuestion.askedCount,
      reason: context.purchaseTask.pendingQuestion.reason,
    };
  }
  const progress = context.clarification;
  if (!progress || progress.field !== field || progress.goalKey !== clarificationGoalKey(context.userState as UserState, context.purchaseTask)) return undefined;
  if (progress.candidateKey && context.rawCandidateSkus.length && progress.candidateKey !== clarificationCandidateKey(context.productFits)) return undefined;
  return progress;
}

export function exhaustedLowRiskQuestion(context: AgentContext): StateField | undefined {
  const field = context.requiredMissingFields[0];
  return field && LOW_RISK_FIELDS.has(field) && (matchingProgress(context, field)?.askedCount ?? 0) >= MAX_LOW_RISK_QUESTIONS
    ? field : undefined;
}

export function comparableFits(context: AgentContext): ProductFit[] {
  const eligible = context.productFits.filter((fit) => fit.status === "eligible" && fit.hardConstraintMatch === true && fit.budgetStatus !== "over");
  const categories = new Set(eligible.map((fit) => PRODUCTS_BY_SKU[fit.sku]?.category));
  return categories.size === 1 && eligible.length >= 2 ? eligible.sort((a, b) => b.score - a.score).slice(0, 2) : [];
}

export function nextClarificationProgress(context: AgentContext, field: StateField, reason: string): ClarificationProgress {
  return {
    goalKey: clarificationGoalKey(context.userState as UserState, context.purchaseTask),
    candidateKey: clarificationCandidateKey(context.productFits),
    field,
    askedCount: (matchingProgress(context, field)?.askedCount ?? 0) + 1,
    reason,
  };
}
