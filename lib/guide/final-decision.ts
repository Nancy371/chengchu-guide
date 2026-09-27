import { KNOWLEDGE_VERSION, PRODUCTS_BY_SKU } from "./catalog";
import { decide } from "./decision";
import { fact } from "./state";
import { checkBudget, checkEligibility, checkSafety } from "./tools";
import type { AgentContext, DecisionDraft, FinalAuthorizationResult, FinalDecisionProposal, ProductFit, Recommendation, StateField, UserState } from "./types";

export function parseFinalProposal(raw: unknown): FinalDecisionProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.kind === "recommend" && Array.isArray(value.skus) && value.skus.length >= 1 && value.skus.length <= 2 && value.skus.every((sku) => typeof sku === "string") && new Set(value.skus).size === value.skus.length && Array.isArray(value.evidenceIds) && value.evidenceIds.every((id) => typeof id === "string") && ["single", "bundle", "alternatives"].includes(String(value.relation))) {
    return { kind: "recommend", skus: value.skus, evidenceIds: value.evidenceIds as string[], relation: value.relation as "single" | "bundle" | "alternatives" };
  }
  if (value.kind === "ask" && typeof value.field === "string" && typeof value.questionGoal === "string" && typeof value.evidenceGap === "string" && value.questionGoal.length <= 160 && value.evidenceGap.length <= 160) {
    return { kind: "ask", field: value.field as StateField, questionGoal: value.questionGoal, evidenceGap: value.evidenceGap };
  }
  if (value.kind === "direct" && (value.source === "rule" || value.source === "fallback") && typeof value.reason === "string") return { kind: "direct", source: value.source, reason: value.reason };
  return null;
}

function recommendation(fit: ProductFit): Recommendation {
  const product = PRODUCTS_BY_SKU[fit.sku];
  return { sku: fit.sku, name: product.name, priceFen: product.priceFen, quantity: 1, reasons: fit.matches.slice(0, 3), tradeoffs: [...product.limitations, ...fit.tradeoffs].slice(0, 3) };
}

export function authorizeFinalDecision(input: { proposal: unknown; context: AgentContext; current: { input: number; state: number; knowledge: string; memory: number } }): FinalAuthorizationResult {
  const { context, current } = input;
  if (context.versions.input !== current.input || context.versions.state !== current.state || context.versions.knowledge !== current.knowledge || current.knowledge !== KNOWLEDGE_VERSION || context.habits.version !== current.memory) return { status: "STALE", reason: "VERSION_MISMATCH" };
  const proposal = parseFinalProposal(input.proposal);
  if (!proposal) return { status: "FALLBACK_REQUIRED", reason: "INVALID_PROPOSAL" };
  const state = context.userState as UserState;
  const safety = checkSafety({ userState: state });
  if (proposal.kind === "direct") {
    const draft = decide(state, [...context.habits.relevant]);
    if (safety.status === "active_risk" && draft.action !== "safety") return { status: "REJECTED", reason: "SAFETY_STOP" };
    if (draft.action === "recommend") {
      const eligibility = checkEligibility({ skus: draft.candidateSkus, userState: state, memories: context.habits.relevant });
      if (eligibility.unknownSkus.length || eligibility.fits.some((fit) => fit.status !== "eligible")) return { status: "REJECTED", reason: "ELIGIBILITY_FAILED" };
      const quote = checkBudget({ skus: draft.candidateSkus, budgetFen: fact<number>(state, "budget"), mode: draft.pricingMode ?? "single" });
      if (quote.withinBudget === false) return { status: "REJECTED", reason: "BUDGET_EXCEEDED" };
    }
    return { status: "APPROVED", reason: proposal.source === "fallback" ? "DETERMINISTIC_FALLBACK" : "DETERMINISTIC_RULE", decision: draft };
  }
  if (safety.status === "active_risk") return { status: "FALLBACK_REQUIRED", reason: "SAFETY_STOP" };
  if (proposal.kind === "ask") {
    if (!context.requiredMissingFields.includes(proposal.field) || !proposal.questionGoal.trim() || !proposal.evidenceGap.trim()) return { status: "FALLBACK_REQUIRED", reason: "QUESTION_NOT_REQUIRED" };
    const draft: DecisionDraft = { action: "clarify", route: "reasoning", routeReason: "最终裁决选择先补充必要信息", questionFields: [proposal.field], candidateSkus: [], recommendations: [], productFits: [...context.productFits], evidence: [], limitations: safety.status === "unclear" ? ["安全信息未明确前不推荐商品"] : [] };
    return { status: "APPROVED", reason: "REQUIRED_FIELD", decision: draft };
  }
  if (safety.status === "unclear") return { status: "FALLBACK_REQUIRED", reason: "SAFETY_UNCLEAR" };
  if (context.requiredMissingFields.length) return { status: "FALLBACK_REQUIRED", reason: "REQUIRED_FIELD_MISSING" };
  const fits = proposal.skus.map((sku) => context.productFits.find((fit) => fit.sku === sku));
  if (fits.some((fit) => !fit || fit.status !== "eligible" || fit.hardConstraintMatch !== true || fit.budgetStatus === "over" || !context.rawCandidateSkus.includes(fit.sku))) return { status: "FALLBACK_REQUIRED", reason: "SKU_NOT_AUTHORIZED" };
  const selected = fits as ProductFit[];
  const evidence = selected.flatMap((fit) => fit.evidence);
  const authorizedIds = new Set(evidence.map((item) => item.id));
  if (!proposal.evidenceIds.length || proposal.evidenceIds.some((id) => !authorizedIds.has(id))) return { status: "FALLBACK_REQUIRED", reason: "EVIDENCE_NOT_AUTHORIZED" };
  const categories = fact<string[]>(state, "categories") ?? [];
  const bundleGoal = categories.includes("cleanser") && categories.includes("moisturizer") && selected.length === 2 && new Set(selected.map((fit) => PRODUCTS_BY_SKU[fit.sku].category)).size === 2;
  const expectedRelation = selected.length === 1 ? "single" : bundleGoal ? "bundle" : "alternatives";
  if (proposal.relation !== expectedRelation) return { status: "FALLBACK_REQUIRED", reason: "PRICING_RELATION_MISMATCH" };
  const quote = checkBudget({ skus: proposal.skus, budgetFen: fact<number>(state, "budget"), mode: expectedRelation });
  if (quote.withinBudget === false || quote.unknownSkus.length) return { status: "FALLBACK_REQUIRED", reason: "BUDGET_EXCEEDED" };
  const draft: DecisionDraft = { action: "recommend", route: "reasoning", routeReason: "最终裁决在已授权候选中完成取舍", questionFields: [], candidateSkus: [...proposal.skus], recommendations: selected.map(recommendation), productFits: [...context.productFits], evidence: evidence.filter((item) => proposal.evidenceIds.includes(item.id)), limitations: [], ...(quote.totalFen !== undefined ? { totalFen: quote.totalFen } : {}), pricingMode: expectedRelation };
  return { status: "APPROVED", reason: "ELIGIBLE_EVIDENCED_AND_PRICED", decision: draft };
}
