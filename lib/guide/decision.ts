import { BUNDLES, KNOWLEDGE_VERSION, PRODUCTS_BY_SKU } from "./catalog";
import { fact } from "./state";
import { activeCategories, checkBudget, checkEligibility, checkSafety, compareProducts, getProductDetail, lookupPolicy, memoryValue, searchProducts, toolEvidence as evidence } from "./tools";
import type { DecisionDraft, DecisionToolName, HabitMemory, ProductFit, Recommendation, StateField, UserState } from "./types";

function productRecommendation(sku: string, fit?: ProductFit): Recommendation {
  const product = PRODUCTS_BY_SKU[sku];
  return {
    sku,
    name: product.name,
    priceFen: product.priceFen,
    quantity: 1,
    reasons: fit?.matches.slice(0, 3) ?? product.suitable,
    tradeoffs: [...product.limitations, ...(fit?.tradeoffs ?? [])].slice(0, 3),
  };
}

function questionsFor(fields: StateField[]): StateField[] {
  return [...new Set(fields)].slice(0, 2);
}

function baseDraft(fits: ProductFit[]): DecisionDraft {
  return {
    action: "clarify",
    route: "direct",
    routeReason: "当前决定还缺少必要信息",
    questionFields: [],
    candidateSkus: [],
    recommendations: [],
    productFits: fits,
    evidence: [],
    limitations: [],
  };
}

export type DecisionToolObserver = (tool: DecisionToolName, outcome: string) => void;

export function decide(state: UserState, memories: HabitMemory[] = [], observe?: DecisionToolObserver): DecisionDraft {
  const used = <T>(tool: DecisionToolName, result: T, outcome: string): T => {
    observe?.(tool, outcome);
    return result;
  };
  const fits = used("check_eligibility", checkEligibility({ skus: ["P101", "P102", "P201", "P202", "P203", "P301"], userState: state, memories }).fits, "已编译目录候选资格");
  const draft = baseDraft(fits);
  const safety = used("check_safety", checkSafety({ userState: state }), "当前状态：" + String(fact(state, "currentDiscomfort") ?? "未提供"));
  const intent = fact<string>(state, "intent");
  const storedSku = fact<string>(state, "targetSku");
  const explicitCategories = fact<string[]>(state, "categories") ?? [];
  const targetSku = storedSku && PRODUCTS_BY_SKU[storedSku] && (!explicitCategories.length || explicitCategories.includes(PRODUCTS_BY_SKU[storedSku].category)) ? storedSku : undefined;
  const policyTopics = fact<string[]>(state, "policyTopics") ?? [];
  const categories = activeCategories(state);
  const budget = fact<number>(state, "budget");
  const skin = fact<string>(state, "skinType");
  const fragrance = fact<string>(state, "fragrancePreference") ?? memoryValue<string>(memories, "fragrance_preference");

  if (safety.status === "active_risk") {
    return {
      ...draft,
      action: "safety",
      route: "safety",
      routeReason: "检测到当前明显不适或受损信息",
      evidence: safety.evidence,
      limitations: ["不作医疗诊断", "本轮不生成商品推荐"],
    };
  }

  if (safety.status === "unclear") {
    return {
      ...draft,
      route: "reasoning",
      routeReason: "不适表述含糊，需要确认是否仍在发生及是否明显",
      questionFields: ["currentDiscomfort"],
      limitations: ["安全信息未明确前不推荐刺激性产品"],
    };
  }

  if (policyTopics.length) {
    const policies = used("lookup_policy", lookupPolicy({ topics: policyTopics }), `待确认政策：${policyTopics.join("、")}`);
    const labels = policies.items.map((item) => item.label);
    const policyEvidence = policies.items.map((item) => item.evidence);
    const product = targetSku ? used("get_product_detail", getProductDetail({ sku: targetSku }), `查询 ${targetSku}`).product : null;
    if (product) {
      return { ...draft, action: "policy_unknown", routeReason: "价格有手册依据，政策问题局部待确认", candidateSkus: [product.sku], recommendations: [productRecommendation(product.sku, fits.find((fit) => fit.sku === product.sku))], evidence: [...policyEvidence, evidence(`price:${product.sku}`, `${product.sku} 手册标价`, `¥${product.priceFen / 100}`)], limitations: labels.map((label) => `${label}需要人工确认`) };
    }
    return { ...draft, action: "policy_unknown", routeReason: "手册未覆盖所问政策", evidence: policyEvidence, limitations: labels.map((label) => `${label}需要人工确认`) };
  }

  const priceProduct = targetSku ? used("get_product_detail", getProductDetail({ sku: targetSku }), `查询 ${targetSku}`).product : null;
  if (priceProduct && intent === "price") {
    const product = priceProduct;
    return { ...draft, action: "price_answer", routeReason: "用户询问手册中明确的商品价格", candidateSkus: [product.sku], recommendations: [productRecommendation(product.sku, fits.find((fit) => fit.sku === product.sku))], evidence: [evidence(`price:${product.sku}`, `${product.sku} 手册标价`, `¥${product.priceFen / 100}`)] };
  }

  if (!categories.length) {
    return { ...draft, questionFields: ["categories"], routeReason: "尚未确认需要的商品品类" };
  }

  if (budget !== undefined && categories.length === 1) {
    const products = used("search_products", searchProducts({ category: categories[0] as "cleanser" | "serum" | "moisturizer" | "travel" }), `检索品类 ${categories[0]}`).products;
    const minimum = Math.min(...products.map((product) => product.priceFen));
    if (Number.isFinite(minimum) && budget < minimum) {
      return {
        ...draft,
        action: "budget_conflict",
        routeReason: "当前品类的手册最低标价已超过预算",
        evidence: products.map((product) => evidence(`price:${product.sku}`, `${product.sku} 手册标价`, `¥${product.priceFen / 100}`)),
        limitations: ["当前目录没有预算内候选，不建议为了购买而自动提高预算"],
        totalFen: minimum,
        budgetGapFen: minimum - budget,
        pricingMode: "single",
      };
    }
  }

  const wantsBundle = categories.includes("cleanser") && categories.includes("moisturizer");
  if (wantsBundle) {
    if (budget === undefined) return { ...draft, questionFields: ["budget"], routeReason: "组合推荐前需先确认总预算" };
    if (!skin) return { ...draft, questionFields: ["skinType"], routeReason: "肤质会改变组合候选" };
    if (skin === "oily" && fragrance === undefined) return { ...draft, questionFields: ["fragrancePreference"], routeReason: "清爽组合带香，需要确认香味偏好" };
    const bundle = skin === "dry" ? BUNDLES.drySensitive : fragrance === "accepts_fragrance" ? BUNDLES.oilyFresh : null;
    if (!bundle) {
      return { ...draft, route: skin === "oily" && fragrance === "must_be_fragrance_free" ? "reasoning" : "direct", routeReason: "当前偏好没有完全匹配的手册组合", questionFields: questionsFor(["fragrancePreference", "coreConcern"]), limitations: ["不会为了凑套装放宽无香要求"] };
    }
    const eligibility = used("check_eligibility", checkEligibility({ skus: bundle, userState: state, memories }), `核对组合 ${bundle.join("+")}`);
    if (eligibility.rejected.length || eligibility.needsInformation.length) {
      return { ...draft, action: "unavailable", routeReason: "组合中存在未通过资格门禁的商品", limitations: eligibility.rejected.flatMap((item) => item.reasons) };
    }
    const budgetCheck = used("check_budget", checkBudget({ skus: bundle, budgetFen: budget, mode: "bundle" }), `组合报价 ${bundle.join("+")}`);
    const totalFen = budgetCheck.totalFen!;
    if (budget < totalFen) {
      return { ...draft, action: "budget_conflict", routeReason: "确定性算价显示组合超过预算", candidateSkus: [...bundle], recommendations: bundle.map((sku) => productRecommendation(sku, fits.find((fit) => fit.sku === sku))), evidence: [evidence(`bundle:${bundle.join("+")}`, "组合算价", bundle.map((sku) => `${sku} ¥${PRODUCTS_BY_SKU[sku].priceFen / 100}`).join(" + ") + ` = ¥${totalFen / 100}`)], totalFen, budgetGapFen: totalFen - budget, pricingMode: "bundle" };
    }
    return { ...draft, action: "recommend", routeReason: "组合满足手册适用条件且在预算内", candidateSkus: [...bundle], recommendations: bundle.map((sku) => productRecommendation(sku, fits.find((fit) => fit.sku === sku))), evidence: [evidence(`bundle:${bundle.join("+")}`, "组合算价", bundle.map((sku) => `${sku} ¥${PRODUCTS_BY_SKU[sku].priceFen / 100}`).join(" + ") + ` = ¥${totalFen / 100}`)], totalFen, pricingMode: "bundle" };
  }

  if (categories.includes("serum")) {
    const fit = used("check_eligibility", checkEligibility({ skus: ["P201"], userState: state, memories }), "核对 P201 资格").fits[0];
    if (fit.status === "excluded") return { ...draft, action: "unavailable", routeReason: "P201 未通过安全或经验门槛", evidence: fit.evidence, limitations: fit.blockers };
    if (fit.status === "needs_information") return { ...draft, questionFields: questionsFor(fit.missing as StateField[]), routeReason: "讨论果酸前需确认使用经验与皮肤状态", evidence: fit.evidence };
    const quote = used("check_budget", checkBudget({ skus: ["P201"], budgetFen: budget, mode: "single" }), "P201 单品报价");
    if (quote.withinBudget === false) return { ...draft, action: "budget_conflict", routeReason: "P201 手册标价超过预算", evidence: [evidence("price:P201", "P201 手册标价", `¥${quote.totalFen! / 100}`)], totalFen: quote.totalFen, budgetGapFen: quote.budgetGapFen, pricingMode: "single" };
    return { ...draft, action: "recommend", routeReason: "P201 满足使用经验和当前状态条件", candidateSkus: ["P201"], recommendations: [productRecommendation("P201", fit)], evidence: fit.evidence, totalFen: quote.totalFen, pricingMode: "single" };
  }

  if (categories.includes("travel")) {
    const fit = used("check_eligibility", checkEligibility({ skus: ["P301"], userState: state, memories }), "核对 P301 资格").fits[0];
    const quote = used("check_budget", checkBudget({ skus: ["P301"], budgetFen: budget, mode: "single" }), "P301 单品报价");
    if (quote.withinBudget === false) return { ...draft, action: "budget_conflict", routeReason: "旅行用品手册标价超过预算", evidence: [evidence("price:P301", "P301 手册标价", `¥${quote.totalFen! / 100}`)], totalFen: quote.totalFen, budgetGapFen: quote.budgetGapFen, pricingMode: "single" };
    return { ...draft, action: "recommend", routeReason: "旅行携带需求明确", candidateSkus: ["P301"], recommendations: [productRecommendation("P301", fit)], evidence: fit.evidence, totalFen: quote.totalFen, pricingMode: "single" };
  }

  const category = categories[0] as "cleanser" | "moisturizer";
  if (!skin) return { ...draft, questionFields: ["skinType"], routeReason: "肤质会改变当前品类的优先候选" };
  if (skin === "oily" && fragrance === undefined) return { ...draft, questionFields: ["fragrancePreference"], routeReason: "偏油候选带香，需要确认香味偏好" };

  const categorySkus = used("search_products", searchProducts({ category }), `检索品类 ${category}`).products.map((product) => product.sku);
  const eligible = used("check_eligibility", checkEligibility({ skus: categorySkus, userState: state, memories }), `核对 ${category} 资格`).fits.filter((fit) => fit.status === "eligible" && used("check_budget", checkBudget({ skus: [fit.sku], budgetFen: budget, mode: "single" }), `${fit.sku} 单品报价`).withinBudget !== false).sort((a, b) => b.score - a.score || PRODUCTS_BY_SKU[a.sku].priceFen - PRODUCTS_BY_SKU[b.sku].priceFen);
  if (!eligible.length) return { ...draft, action: "unavailable", routeReason: "当前硬约束下没有完全匹配的候选", limitations: ["不会把未获手册支持的适用性补成推荐"] };
  const selected = eligible.slice(0, 2);
  const compared = used("compare_products", compareProducts({ skus: selected.map((item) => item.sku), fits }), `比较 ${selected.map((item) => item.sku).join("、")}`);
  const quote = used("check_budget", checkBudget({ skus: selected.map((item) => item.sku), budgetFen: budget, mode: selected.length === 1 ? "single" : "alternatives" }), selected.length === 1 ? "单品报价" : "备选商品分别报价");
  return { ...draft, action: "recommend", routeReason: "候选已通过资格门禁并按明确偏好排序", candidateSkus: compared.items.map((item) => item.product.sku), recommendations: selected.map((fit) => productRecommendation(fit.sku, fit)), evidence: selected.flatMap((fit) => fit.evidence), ...(selected.length === 1 ? { totalFen: quote.totalFen, pricingMode: "single" as const } : { pricingMode: "alternatives" as const }) };
}

export function applyReasoningProposal(draft: DecisionDraft, proposal: unknown, state?: UserState): DecisionDraft {
  if (!proposal || typeof proposal !== "object") return { ...draft, route: "degraded", routeReason: `${draft.routeReason}；推理提案无有效结构` };
  const raw = proposal as { candidateSkus?: unknown; questionFields?: unknown };
  const budget = state ? fact<number>(state, "budget") : undefined;
  const allowed = new Set(draft.productFits.filter((fit) => fit.status !== "excluded" && (budget === undefined || PRODUCTS_BY_SKU[fit.sku].priceFen <= budget)).map((fit) => fit.sku));
  const candidateSkus = Array.isArray(raw.candidateSkus) ? raw.candidateSkus.filter((sku): sku is string => typeof sku === "string" && allowed.has(sku)) : [];
  const validQuestionFields = new Set<StateField>(["budget", "skinType", "sensitiveTendency", "currentDiscomfort", "fragrancePreference", "acidExperience", "coreConcern"]);
  const questionFields = Array.isArray(raw.questionFields) ? raw.questionFields.filter((field): field is StateField => typeof field === "string" && validQuestionFields.has(field as StateField)).slice(0, 2) : [];
  if (candidateSkus.length) {
    return { ...draft, action: "recommend", candidateSkus, recommendations: candidateSkus.map((sku) => productRecommendation(sku, draft.productFits.find((fit) => fit.sku === sku))), routeReason: `${draft.routeReason}；推理仅在合规候选内完成取舍` };
  }
  return { ...draft, action: "clarify", questionFields: questionFields.length ? questionFields : draft.questionFields, routeReason: `${draft.routeReason}；推理选择先澄清关键冲突` };
}

export { KNOWLEDGE_VERSION };
