import { PRODUCTS_BY_SKU } from "./catalog";
import { fact } from "./state";
import type { AgentContext, CandidateEvaluation, ProductFit, StateField, UserState } from "./types";

export const MAX_LOW_RISK_QUESTIONS = 4;
export const LOW_RISK_FIELDS = new Set<StateField>(["skinType", "fragrancePreference", "texturePreference", "coreConcern"]);

function choicesCanChange(context: AgentContext, fits: readonly ProductFit[], field: StateField): boolean {
  const eligible = fits.filter((fit) => fit.status === "eligible");
  if (eligible.length < 2) return false;
  if (field === "fragrancePreference" && context.goal.categories.length > 1 &&
    fact<string>(context.userState as UserState, "skinType") === "dry") return false;
  if (field === "skinType") {
    return new Set(eligible.map((fit) => {
      const product = PRODUCTS_BY_SKU[fit.sku];
      return product.suitable.some((item) => /偏干|干燥/.test(item)) ? "dry" : product.suitable.some((item) => /偏油/.test(item)) ? "oily" : "other";
    })).size > 1;
  }
  if (field === "fragrancePreference") return new Set(eligible.map((fit) => PRODUCTS_BY_SKU[fit.sku].fragrance)).size > 1;
  return false;
}

function evaluation(context: AgentContext, outcome: CandidateEvaluation["outcome"], field?: StateField, questionImpact?: string): CandidateEvaluation {
  return {
    productFits: context.candidateProducts,
    rejected: context.rejectedProducts,
    ...(field ? { requiredGap: field, selectedQuestion: field } : {}),
    ...(questionImpact ? { questionImpact } : {}),
    outcome,
    versions: context.versions,
  };
}

export function evaluateCandidates(context: AgentContext): CandidateEvaluation {
  const safety = context.hardConstraints.safety;
  if (safety === "active_risk") return evaluation(context, "safety");
  if (safety === "unclear") return evaluation(context, "clarify", "currentDiscomfort", "确认当前是否仍有不适，决定能否继续选购");
  if (context.purchaseTask.goal.kind === "gift_box_ambiguous") return evaluation(context, "clarify", "giftBoxType", "确定要找旅行分装瓶还是护肤品礼盒");
  if (context.purchaseTask.goal.kind === "unsupported_skincare_gift_box") return evaluation(context, "unavailable");
  if (!context.goal.categories.length && !context.goal.targetSku) return evaluation(context, "clarify", "categories", "确定要选的商品品类");

  const fits = context.productFits;
  const available = fits.filter((fit) => fit.status === "eligible");
  const pending = fits.filter((fit) => fit.status === "needs_information");
  const currentState = context.userState as UserState;
  const orderedEligibility: StateField[] = ["currentDiscomfort", "sensitiveTendency", "acidExperience"];
  const impact: Partial<Record<StateField, string>> = {
    currentDiscomfort: "确认当前是否稳定，决定能否安全继续选购",
    sensitiveTendency: "确认敏感倾向，决定果酸候选能否进入推荐",
    acidExperience: "确认使用经验，决定果酸候选是否具备推荐资格",
  };
  for (const field of orderedEligibility) {
    if (pending.some((fit) => fit.missing.includes(field))) {
      return evaluation(context, "clarify", field, impact[field]);
    }
  }

  // A known low budget can end the search immediately; no further preference
  // question has value when every catalog candidate is already out of range.
  if (context.purchaseTask.budget.status === "limited" && !available.length && !pending.length &&
    context.rejectedProducts.some((item) => item.stage === "budget")) return evaluation(context, "budget_conflict");

  const delegated = fact<boolean>(currentState, "delegateChoice") === true;
  const rankingFields: StateField[] = ["skinType", "fragrancePreference"];
  let exhausted: StateField | undefined;
  if (!delegated) for (const field of rankingFields) {
    if (fact(currentState, field) !== undefined || !choicesCanChange(context, fits, field)) continue;
    const attempts = context.purchaseTask.questionCounts?.[field] ??
      (context.purchaseTask.pendingQuestion?.field === field ? context.purchaseTask.pendingQuestion.askedCount :
        context.clarification?.field === field ? context.clarification.askedCount : 0);
    if (attempts >= MAX_LOW_RISK_QUESTIONS) { exhausted = field; break; }
    return evaluation(context, "clarify", field, "不同回答会改变合格商品的取舍");
  }

  if (context.purchaseTask.budget.status === "unknown") return evaluation(context, "clarify", "budget", "确认最后的价格范围，排除超预算候选");
  if (context.purchaseTask.budget.status === "declined") return evaluation(context, "unavailable");
  if (exhausted && available.length >= 2) return evaluation(context, "compare", exhausted, "偏好仍不明确，只展示核实过的候选差别");
  if (!available.length && !pending.length) return evaluation(context, "unavailable");
  return evaluation(context, "ready");
}
