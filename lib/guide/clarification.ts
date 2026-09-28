import { activeCategories } from "./tools";
import { PRODUCTS_BY_SKU } from "./catalog";
import { decide } from "./decision";
import { fact } from "./state";
import type { AgentContext, ClarificationProgress, DecisionDraft, ProductFit, StateField, UserState } from "./types";

export const MAX_LOW_RISK_QUESTIONS = 4;
export const LOW_RISK_FIELDS = new Set<StateField>(["skinType", "fragrancePreference", "texturePreference", "coreConcern"]);

export function clarificationGoalKey(state: UserState): string {
  const categories = activeCategories(state).slice().sort();
  const explicitCategories = fact<string[]>(state, "categories") ?? [];
  return JSON.stringify({ categories, targetSku: explicitCategories.length ? null : fact<string>(state, "targetSku") ?? null, budget: fact<number>(state, "budget") ?? null });
}

export function clarificationCandidateKey(fits: ReadonlyArray<ProductFit>): string {
  return fits.filter((fit) => fit.status === "eligible" && fit.hardConstraintMatch !== false && fit.budgetStatus !== "over").map((fit) => fit.sku).sort().join("+");
}

export function requiredInformation(context: AgentContext, baseline: DecisionDraft = decide(context.userState as UserState, [...context.habits.relevant])): StateField[] {
  if (context.hardConstraints.safety === "active_risk") return [];
  if (context.hardConstraints.safety === "unclear") return ["currentDiscomfort"];
  if (baseline.action !== "clarify") return [];
  const eligible = context.productFits.filter((fit) => fit.status === "eligible");
  const delegated = fact<boolean>(context.userState as UserState, "delegateChoice") === true;
  return [...new Set(baseline.questionFields)].filter((field) => {
    if (!LOW_RISK_FIELDS.has(field)) return true;
    if (eligible.length === 1 || delegated) return false;
    return true;
  });
}

export function matchingProgress(context: AgentContext, field: StateField): ClarificationProgress | undefined {
  const progress = context.clarification;
  if (!progress || progress.field !== field || progress.goalKey !== clarificationGoalKey(context.userState as UserState)) return undefined;
  if (progress.candidateKey && context.rawCandidateSkus.length && progress.candidateKey !== clarificationCandidateKey(context.productFits)) return undefined;
  return progress;
}

export function exhaustedLowRiskQuestion(context: AgentContext): StateField | undefined {
  const field = context.requiredMissingFields[0];
  return field && LOW_RISK_FIELDS.has(field) && matchingProgress(context, field)?.askedCount === MAX_LOW_RISK_QUESTIONS
    ? field : undefined;
}

export function comparableFits(context: AgentContext): ProductFit[] {
  const eligible = context.productFits.filter((fit) => fit.status === "eligible" && fit.hardConstraintMatch === true && fit.budgetStatus !== "over");
  const categories = new Set(eligible.map((fit) => PRODUCTS_BY_SKU[fit.sku]?.category));
  return categories.size === 1 && eligible.length >= 2 ? eligible.sort((a, b) => b.score - a.score).slice(0, 2) : [];
}

export function nextClarificationProgress(context: AgentContext, field: StateField, reason: string): ClarificationProgress {
  return {
    goalKey: clarificationGoalKey(context.userState as UserState),
    candidateKey: clarificationCandidateKey(context.productFits),
    field,
    askedCount: (matchingProgress(context, field)?.askedCount ?? 0) + 1,
    reason,
  };
}
