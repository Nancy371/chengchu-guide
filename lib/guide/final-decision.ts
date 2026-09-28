import { KNOWLEDGE_VERSION, PRODUCTS_BY_SKU } from "./catalog";
import { decide } from "./decision";
import { fact } from "./state";
import { checkBudget, checkEligibility, checkSafety } from "./tools";
import { LOW_RISK_FIELDS, MAX_LOW_RISK_QUESTIONS, comparableFits, exhaustedLowRiskQuestion, matchingProgress } from "./clarification";
import type { AgentContext, DecisionDraft, FinalAuthorizationResult, FinalDecisionProposal, ProductFit, Recommendation, StateField, TurnSignal, UserState } from "./types";

export function parseFinalProposal(raw: unknown): FinalDecisionProposal | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  if (value.kind === "recommend" && Array.isArray(value.skus) && value.skus.length >= 1 && value.skus.length <= 2 && value.skus.every((sku) => typeof sku === "string") && new Set(value.skus).size === value.skus.length && Array.isArray(value.evidenceIds) && value.evidenceIds.every((id) => typeof id === "string") && ["single", "bundle", "alternatives"].includes(String(value.relation))) {
    return { kind: "recommend", skus: value.skus, evidenceIds: value.evidenceIds as string[], relation: value.relation as "single" | "bundle" | "alternatives" };
  }
  if (value.kind === "ask" && typeof value.field === "string" && typeof value.questionGoal === "string" && typeof value.evidenceGap === "string" && value.questionGoal.length <= 160 && value.evidenceGap.length <= 160) {
    return { kind: "ask", field: value.field as StateField, questionGoal: value.questionGoal, evidenceGap: value.evidenceGap };
  }
  if (value.kind === "comparison_only" && Array.isArray(value.skus) && value.skus.length === 2 && value.skus.every((sku) => typeof sku === "string") && new Set(value.skus).size === 2 && Array.isArray(value.evidenceIds) && value.evidenceIds.every((id) => typeof id === "string") && typeof value.field === "string") {
    return { kind: "comparison_only", skus: value.skus, evidenceIds: value.evidenceIds as string[], field: value.field as StateField };
  }
  if (value.kind === "price_list" && Array.isArray(value.skus) && value.skus.length >= 1 && value.skus.length <= 6 && value.skus.every((sku) => typeof sku === "string") && new Set(value.skus).size === value.skus.length && Array.isArray(value.evidenceIds) && value.evidenceIds.every((id) => typeof id === "string")) {
    return { kind: "price_list", skus: value.skus, evidenceIds: value.evidenceIds as string[] };
  }
  if (value.kind === "direct" && (value.source === "rule" || value.source === "fallback") && typeof value.reason === "string" && (value.action === undefined || value.action === "close" || value.action === "unavailable")) return { kind: "direct", source: value.source, reason: value.reason, ...(value.action ? { action: value.action } : {}) };
  return null;
}

function recommendation(fit: ProductFit): Recommendation {
  const product = PRODUCTS_BY_SKU[fit.sku];
  return { sku: fit.sku, name: product.name, priceFen: product.priceFen, quantity: 1, reasons: fit.matches.slice(0, 3), tradeoffs: [...product.limitations, ...fit.tradeoffs].slice(0, 3) };
}

export function safetyDecision(state: UserState): DecisionDraft {
  return { action: "safety", route: "safety", routeReason: "检测到当前明显不适或受损信息", questionFields: [], candidateSkus: [], recommendations: [], productFits: [], evidence: checkSafety({ userState: state }).evidence, limitations: ["不作医疗诊断", "本轮不生成商品推荐"] };
}

export function authorizeFinalDecision(input: { proposal: unknown; context: AgentContext; current: { input: number; state: number; knowledge: string; memory: number }; signals?: TurnSignal[] }): FinalAuthorizationResult {
  const { context, current } = input;
  if (context.versions.input !== current.input || context.versions.state !== current.state || context.versions.knowledge !== current.knowledge || current.knowledge !== KNOWLEDGE_VERSION || context.habits.version !== current.memory) return { status: "STALE", reason: "VERSION_MISMATCH" };
  if (context.candidateEvaluation && (context.candidateEvaluation.versions.input !== current.input || context.candidateEvaluation.versions.state !== current.state || context.candidateEvaluation.versions.knowledge !== current.knowledge)) return { status: "STALE", reason: "CANDIDATE_VERSION_MISMATCH" };
  const proposal = parseFinalProposal(input.proposal);
  if (!proposal) return { status: "FALLBACK_REQUIRED", reason: "INVALID_PROPOSAL" };
  const state = context.userState as UserState;
  const safety = checkSafety({ userState: state });
  if (proposal.kind === "direct") {
    if (safety.status === "active_risk") return { status: "APPROVED", reason: "SAFETY_STOP", decision: safetyDecision(state) };
    if (proposal.action === "close") {
      if (!input.signals?.some((signal) => signal.value === "reject" && signal.subject !== "other" && signal.temporal !== "historical")) return { status: "REJECTED", reason: "CLOSE_NOT_REQUESTED" };
      return { status: "APPROVED", reason: "USER_REJECTED", decision: { action: "close", route: "direct", routeReason: "用户明确表示停止推荐或暂不购买", questionFields: [], candidateSkus: [], recommendations: [], productFits: [], evidence: [], limitations: [] } };
    }
    if (proposal.action === "unavailable") {
      const declined = input.signals?.some((signal) => signal.value === "decline_answer" && signal.subject === "self" && signal.temporal !== "historical");
      const unsupportedGift = context.purchaseTask.goal.kind === "unsupported_skincare_gift_box";
      const noAlternative = context.purchaseTask.turnAction.kind === "request_alternative" && context.productFits.every((fit) => fit.status !== "eligible");
      if (!exhaustedLowRiskQuestion(context) && !(declined && context.requiredMissingFields.length) && !unsupportedGift && !noAlternative) return { status: "REJECTED", reason: "UNAVAILABLE_NOT_JUSTIFIED" };
      const reason = unsupportedGift ? "目录暂未提供护肤品礼盒" : noAlternative ? "当前条件下没有尚未展示的合格候选" : declined ? "用户暂不愿回答必要信息" : "必要偏好仍不明确，无法确定当前组合";
      const limitation = unsupportedGift ? "当前目录只有 P301 旅行分装瓶礼盒，不是护肤品套装" : noAlternative ? "符合当前目标和约束的商品已经展示完了" : declined && safety.status === "unclear" ? "当前不适还没核实，暂时不能安全推荐；以后想继续选购时仍需要先确认" : "这点偏好仍不明确，暂时不能替你选定组合";
      return { status: "APPROVED", reason: unsupportedGift ? "UNSUPPORTED_GIFT_BOX" : noAlternative ? "NO_NEW_ALTERNATIVE" : declined ? "DECLINED_REQUIRED_INFO" : "LOW_RISK_UNRESOLVED", decision: { action: "unavailable", route: "degraded", routeReason: reason, questionFields: [], candidateSkus: [], recommendations: [], productFits: [...context.productFits], evidence: [], limitations: [limitation] } };
    }
    const draft = decide(state, [...context.habits.relevant]);
    if (draft.action === "recommend" && context.purchaseTask.budget.status !== "limited" && context.purchaseTask.budget.status !== "unlimited") return { status: "REJECTED", reason: "BUDGET_REQUIRED" };
    if (draft.action === "recommend" && context.requiredMissingFields.length) return { status: "REJECTED", reason: "REQUIRED_FIELD_MISSING" };
    if (draft.action === "recommend") {
      if (context.purchaseTask.turnAction.kind === "request_alternative" && draft.candidateSkus.some((sku) => context.purchaseTask.displayedSkus.includes(sku))) return { status: "REJECTED", reason: "ALREADY_DISPLAYED" };
      const eligibility = checkEligibility({ skus: draft.candidateSkus, userState: state, memories: context.habits.relevant });
      if (eligibility.unknownSkus.length || eligibility.fits.some((fit) => fit.status !== "eligible")) return { status: "REJECTED", reason: "ELIGIBILITY_FAILED" };
      const quote = checkBudget({ skus: draft.candidateSkus, budgetFen: fact<number>(state, "budget"), mode: draft.pricingMode ?? "single" });
      if (quote.withinBudget === false) return { status: "REJECTED", reason: "BUDGET_EXCEEDED" };
    }
    return { status: "APPROVED", reason: proposal.source === "fallback" ? "DETERMINISTIC_FALLBACK" : "DETERMINISTIC_RULE", decision: draft };
  }
  if (safety.status === "active_risk") return { status: "FALLBACK_REQUIRED", reason: "SAFETY_STOP" };
  if (proposal.kind === "comparison_only") {
    const declined = input.signals?.some((signal) => signal.value === "decline_answer" && signal.subject === "self" && signal.temporal !== "historical");
    if (context.candidateEvaluation && context.candidateEvaluation.outcome !== "compare" && !exhaustedLowRiskQuestion(context) && !declined) return { status: "REJECTED", reason: "COMPARISON_NOT_READY" };
    const peers = comparableFits(context);
    if (safety.status === "unclear" || context.purchaseTask.budget.status !== "limited" && context.purchaseTask.budget.status !== "unlimited" || !LOW_RISK_FIELDS.has(proposal.field) || context.requiredMissingFields.length !== 1 || context.requiredMissingFields[0] !== proposal.field || ((matchingProgress(context, proposal.field)?.askedCount ?? 0) < MAX_LOW_RISK_QUESTIONS && !declined) || peers.length !== 2 || proposal.skus.some((sku) => !peers.some((fit) => fit.sku === sku))) return { status: "REJECTED", reason: "COMPARISON_NOT_READY" };
    const fits = proposal.skus.map((sku) => context.productFits.find((fit) => fit.sku === sku));
    if (fits.some((fit) => !fit || fit.status !== "eligible" || fit.hardConstraintMatch !== true || fit.budgetStatus === "over" || !context.rawCandidateSkus.includes(fit.sku))) return { status: "REJECTED", reason: "SKU_NOT_AUTHORIZED" };
    const selected = fits as ProductFit[];
    const evidence = selected.flatMap((fit) => fit.evidence);
    const allowedIds = new Set(evidence.map((item) => item.id));
    if (!proposal.evidenceIds.length || proposal.evidenceIds.some((id) => !allowedIds.has(id))) return { status: "REJECTED", reason: "EVIDENCE_NOT_AUTHORIZED" };
    const quote = checkBudget({ skus: proposal.skus, budgetFen: fact<number>(state, "budget"), mode: "alternatives" });
    if (quote.withinBudget === false || quote.unknownSkus.length) return { status: "REJECTED", reason: "BUDGET_EXCEEDED" };
    return { status: "APPROVED", reason: "FACTUAL_COMPARISON_ONLY", decision: { action: "comparison_only", route: "direct", routeReason: "偏好尚未明确，仅展示通过资格检查的商品事实", questionFields: [], candidateSkus: [...proposal.skus], recommendations: [], productFits: [...context.productFits], evidence: evidence.filter((item) => proposal.evidenceIds.includes(item.id)), limitations: ["未指定主推商品"], pricingMode: "alternatives" } };
  }
  if (proposal.kind === "ask") {
    if (context.candidateEvaluation && context.candidateEvaluation.selectedQuestion !== proposal.field) return { status: "FALLBACK_REQUIRED", reason: "QUESTION_NOT_SELECTED" };
    if (!context.requiredMissingFields.includes(proposal.field) || !proposal.questionGoal.trim() || !proposal.evidenceGap.trim()) return { status: "FALLBACK_REQUIRED", reason: "QUESTION_NOT_REQUIRED" };
    const draft: DecisionDraft = { action: "clarify", route: "reasoning", routeReason: "最终裁决选择先补充必要信息", questionFields: [proposal.field], candidateSkus: [], recommendations: [], productFits: [...context.productFits], evidence: [], limitations: safety.status === "unclear" ? ["安全信息未明确前不推荐商品"] : [] };
    return { status: "APPROVED", reason: "REQUIRED_FIELD", decision: draft };
  }
  if (proposal.kind === "price_list") {
    if (safety.status === "unclear" || context.purchaseTask.budget.status !== "declined") return { status: "REJECTED", reason: "PRICE_LIST_NOT_ALLOWED" };
    const goalCategories = new Set(context.purchaseTask.goal.categories);
    const selected = proposal.skus.map((sku) => PRODUCTS_BY_SKU[sku]).filter(Boolean);
    if (selected.length !== proposal.skus.length || selected.some((product) => !goalCategories.has(product.category))) return { status: "REJECTED", reason: "SKU_NOT_AUTHORIZED" };
    const allowedIds = new Set(selected.map((product) => `catalog:${product.sku}`));
    if (!proposal.evidenceIds.length || proposal.evidenceIds.some((id) => !allowedIds.has(id))) return { status: "REJECTED", reason: "EVIDENCE_NOT_AUTHORIZED" };
    return { status: "APPROVED", reason: "BUDGET_DECLINED_PRICE_LIST", decision: { action: "price_list", route: "direct", routeReason: "用户不提供预算，仅列出当前品类的已核实标价", questionFields: [], candidateSkus: [...proposal.skus], recommendations: [], productFits: [...context.candidateProducts], evidence: selected.map((product) => ({ id: `catalog:${product.sku}`, label: `${product.sku} 商品事实`, detail: `${product.name} · ¥${product.priceFen / 100}`, source: product.source, status: "supported" as const })), limitations: ["未指定主推商品"], pricingMode: proposal.skus.length === 1 ? "single" : "alternatives" } };
  }
  if (safety.status === "unclear") return { status: "FALLBACK_REQUIRED", reason: "SAFETY_UNCLEAR" };
  if (context.candidateEvaluation && context.candidateEvaluation.outcome !== "ready") return { status: "FALLBACK_REQUIRED", reason: "CANDIDATE_NOT_READY" };
  if (context.purchaseTask.budget.status !== "limited" && context.purchaseTask.budget.status !== "unlimited") return { status: "FALLBACK_REQUIRED", reason: "BUDGET_REQUIRED" };
  if (context.requiredMissingFields.length) return { status: "FALLBACK_REQUIRED", reason: "REQUIRED_FIELD_MISSING" };
  const fits = proposal.skus.map((sku) => context.productFits.find((fit) => fit.sku === sku));
  if (fits.some((fit) => !fit || fit.status !== "eligible" || fit.hardConstraintMatch !== true || fit.budgetStatus === "over" || !context.rawCandidateSkus.includes(fit.sku))) return { status: "FALLBACK_REQUIRED", reason: "SKU_NOT_AUTHORIZED" };
  const selected = fits as ProductFit[];
  if (context.purchaseTask.turnAction.kind === "request_alternative" && proposal.skus.some((sku) => context.purchaseTask.displayedSkus.includes(sku))) return { status: "FALLBACK_REQUIRED", reason: "ALREADY_DISPLAYED" };
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
