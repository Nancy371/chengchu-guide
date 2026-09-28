import { MANUAL_SOURCE, PRODUCTS, PRODUCTS_BY_SKU, UNSUPPORTED_POLICY_TOPICS } from "./catalog";
import { fact } from "./state";
import type { EvidenceItem, HabitMemory, Product, ProductFit, UserState } from "./types";

export interface ProductSearchInput { category?: Product["category"]; skus?: readonly string[] }
export interface ProductSearchResult { products: Product[]; unknownSkus: string[] }
export interface ProductDetailInput { sku: string }
export interface ProductDetailResult { product: Product | null; source: string | null }
export interface SafetyInput { userState: Readonly<UserState> }
export interface SafetyResult { status: "active_risk" | "unclear" | "explicitly_stable" | "not_provided"; evidence: EvidenceItem[]; blocksRecommendation: boolean; blocksAcid: boolean }
export interface EligibilityInput { skus: readonly string[]; userState: Readonly<UserState>; memories?: readonly HabitMemory[] }
export interface EligibilityResult { fits: ProductFit[]; eligible: string[]; needsInformation: Array<{ sku: string; fields: string[] }>; rejected: Array<{ sku: string; reasons: string[] }>; unknownSkus: string[] }
export interface BudgetInput { skus: readonly string[]; budgetFen?: number; mode: "single" | "bundle" | "alternatives" }
export interface BudgetResult { mode: BudgetInput["mode"]; lines: Array<{ sku: string; priceFen: number; withinBudget: boolean | null }>; totalFen?: number; budgetGapFen?: number; withinBudget: boolean | null; unknownSkus: string[] }
export interface ComparisonInput { skus: readonly string[]; fits: readonly ProductFit[] }
export interface ComparisonResult { items: Array<{ product: Product; fit: ProductFit | null }>; unknownSkus: string[] }
export interface PolicyInput { topics: readonly string[] }
export interface PolicyResult { items: Array<{ topic: string; label: string; status: "unknown"; detail: string; evidence: EvidenceItem }> }

export function toolEvidence(id: string, label: string, detail: string, status: EvidenceItem["status"] = "supported"): EvidenceItem {
  return { id, label, detail, source: MANUAL_SOURCE, status };
}

export function searchProducts(input: ProductSearchInput): ProductSearchResult {
  const known = new Set(PRODUCTS.map((product) => product.sku));
  const wanted = input.skus ? new Set(input.skus) : null;
  return { products: PRODUCTS.filter((product) => (!input.category || product.category === input.category) && (!wanted || wanted.has(product.sku))), unknownSkus: input.skus?.filter((sku) => !known.has(sku)) ?? [] };
}

export function getProductDetail(input: ProductDetailInput): ProductDetailResult {
  const product = PRODUCTS_BY_SKU[input.sku] ?? null;
  return { product, source: product?.source ?? null };
}

export function checkSafety(input: SafetyInput): SafetyResult {
  const risk = fact<boolean | string>(input.userState, "currentDiscomfort");
  const status: SafetyResult["status"] = risk === true ? "active_risk" : risk === "unclear" ? "unclear" : risk === false ? "explicitly_stable" : "not_provided";
  return { status, blocksRecommendation: status === "active_risk", blocksAcid: status !== "explicitly_stable", evidence: status === "active_risk" ? [toolEvidence("safety:discomfort", "安全边界", "明显不适、受损或持续问题时，停止刺激性尝试并建议咨询专业人士")] : [] };
}

export function checkBudget(input: BudgetInput): BudgetResult {
  const unknownSkus = input.skus.filter((sku) => !PRODUCTS_BY_SKU[sku]);
  const lines = input.skus.filter((sku) => PRODUCTS_BY_SKU[sku]).map((sku) => ({ sku, priceFen: PRODUCTS_BY_SKU[sku].priceFen, withinBudget: input.budgetFen === undefined ? null : PRODUCTS_BY_SKU[sku].priceFen <= input.budgetFen }));
  const totalFen = input.mode === "alternatives" || unknownSkus.length ? undefined : lines.reduce((sum, line) => sum + line.priceFen, 0);
  const withinBudget = input.budgetFen === undefined || unknownSkus.length ? null : input.mode === "alternatives" ? lines.every((line) => line.withinBudget) : (totalFen ?? 0) <= input.budgetFen;
  return { mode: input.mode, lines, totalFen, budgetGapFen: withinBudget === false && totalFen !== undefined ? totalFen - input.budgetFen! : undefined, withinBudget, unknownSkus };
}

export function lookupPolicy(input: PolicyInput): PolicyResult {
  return { items: input.topics.map((topic) => {
    const label = UNSUPPORTED_POLICY_TOPICS[topic] ?? topic;
    const detail = "品牌手册未提供，需要向门店或系统确认";
    return { topic, label, status: "unknown" as const, detail, evidence: toolEvidence(`policy:${topic}`, `${label}政策`, detail, "unknown") };
  }) };
}

export function compareProducts(input: ComparisonInput): ComparisonResult {
  const unknownSkus = input.skus.filter((sku) => !PRODUCTS_BY_SKU[sku]);
  return { items: input.skus.filter((sku) => PRODUCTS_BY_SKU[sku]).map((sku) => ({ product: PRODUCTS_BY_SKU[sku], fit: input.fits.find((fit) => fit.sku === sku) ?? null })), unknownSkus };
}

export function activeCategories(state: UserState): string[] {
  const categories = fact<string[]>(state, "categories") ?? [];
  const targetSku = fact<string>(state, "targetSku");
  if (targetSku && PRODUCTS_BY_SKU[targetSku] && (!categories.length || categories.includes(PRODUCTS_BY_SKU[targetSku].category))) return [PRODUCTS_BY_SKU[targetSku].category];
  return categories;
}

export function memoryValue<T extends string | boolean>(memories: HabitMemory[], kind: HabitMemory["kind"]): T | undefined {
  return memories.find((memory) => memory.kind === kind)?.value as T | undefined;
}

export function compileProductFits(state: UserState, memories: HabitMemory[] = []): ProductFit[] {
  const categories = activeCategories(state);
  const skin = fact<string>(state, "skinType");
  const sensitive = fact<boolean>(state, "sensitiveTendency");
  const safety = checkSafety({ userState: state });
  const fragrance = fact<string>(state, "fragrancePreference") ?? memoryValue<string>(memories, "fragrance_preference");
  const acidExperience = fact<boolean>(state, "acidExperience");
  const travel = fact<boolean>(state, "travelNeed");

  return PRODUCTS.map((product) => {
    const matches: string[] = [];
    const blockers: string[] = [];
    const missing: string[] = [];
    const tradeoffs: string[] = [];
    let score = 0;

    if (categories.length && !categories.includes(product.category)) blockers.push("不属于当前需要的品类");
    if (safety.status === "active_risk") blockers.push("当前明显不适时暂停商品推荐");

    if (product.sku === "P101") {
      if (skin === "dry") { matches.push("偏干肤质与手册适用提示一致"); score += 30; }
      if (sensitive === true) { matches.push("敏感倾向且当前稳定时可考虑"); score += 20; }
      if (fragrance === "must_be_fragrance_free" || fragrance === "fragrance_sensitive") { matches.push("无香型符合香味偏好"); score += 18; }
    }
    if (product.sku === "P102") {
      if (skin === "oily") { matches.push("偏油且偏好清爽时可考虑"); score += 30; }
      if (fact<string>(state, "coreConcern") === "fresh_texture") { matches.push("清洁感较强，符合清爽诉求"); score += 12; }
      // Accepting a scent does not establish a match to an unspecified scent note.
      if (fragrance === "fragrance_sensitive") { tradeoffs.push("带香味，手册提示对香味敏感者不优先"); score -= 25; }
      if (fragrance === "must_be_fragrance_free") blockers.push("用户明确要求无香，而本品带香味");
    }
    if (product.sku === "P201") {
      if (sensitive === true) blockers.push("手册明确不推荐敏感皮肤使用 P201");
      if (safety.status === "active_risk" || safety.status === "unclear") blockers.push("不适情况未排除，不推荐讨论果酸");
      if (sensitive === undefined) missing.push("sensitiveTendency");
      if (safety.status === "not_provided") missing.push("currentDiscomfort");
      if (acidExperience === undefined) missing.push("acidExperience");
      if (acidExperience === false) blockers.push("没有相关果酸使用经验");
      if (acidExperience === true) { matches.push("已有果酸使用经验"); score += 30; }
      if (fact<string>(state, "coreConcern") === "roughness") { matches.push("希望改善粗糙与手册适用提示一致"); score += 25; }
      tradeoffs.push("含 8% 果酸复合成分，使用时需注意防晒");
    }
    if (product.sku === "P202") {
      if (skin === "dry") { matches.push("偏干与保湿提示一致"); score += 28; }
      if (sensitive === true) { matches.push("屏障脆弱倾向且当前稳定时可考虑"); score += 18; }
      if (fragrance === "must_be_fragrance_free" || fragrance === "fragrance_sensitive") { matches.push("无香型符合香味偏好"); score += 15; }
      tradeoffs.push("不作治疗承诺");
    }
    if (product.sku === "P203") {
      if (skin === "oily") { matches.push("偏油且喜欢轻薄肤感时可考虑"); score += 28; }
      if (fact<string>(state, "coreConcern") === "fresh_texture") { matches.push("清爽质地符合轻薄诉求"); score += 15; }
      // The catalog does not identify the scent, so preference adds no match score.
      if (fragrance === "fragrance_sensitive") { tradeoffs.push("带淡香，手册提示对香味敏感者不优先"); score -= 25; }
      if (fragrance === "must_be_fragrance_free") blockers.push("用户明确要求无香，而本品带淡香");
    }
    if (product.sku === "P301") {
      if (travel === true) { matches.push("旅行携带需求明确"); score += 40; }
      else blockers.push("仅在旅行携带需求明确时讨论");
      tradeoffs.push("不属于护肤功效产品");
    }

    const meaningfulBlockers = blockers.filter((item) => item !== "不属于当前需要的品类");
    const status = blockers.length ? "excluded" : missing.length ? "needs_information" : "eligible";
    return {
      sku: product.sku,
      status,
      score,
      matches,
      blockers,
      missing,
      tradeoffs,
      allowedClaims: [...product.features, ...product.suitable, ...product.limitations],
      evidence: [
        toolEvidence(`catalog:${product.sku}`, `${product.sku} 商品事实`, `${product.name} · ¥${(product.priceFen / 100).toFixed(0)} · ${product.features.join("、")}`),
        ...(meaningfulBlockers.length ? [toolEvidence(`gate:${product.sku}`, "资格门禁", meaningfulBlockers.join("；"), "contradicted")] : []),
      ],
    };
  });
}

export function checkEligibility(input: EligibilityInput): EligibilityResult {
  const allFits = compileProductFits(input.userState as UserState, [...(input.memories ?? [])]);
  const unknownSkus = input.skus.filter((sku) => !PRODUCTS_BY_SKU[sku]);
  const fits = input.skus.flatMap((sku) => {
    const fit = allFits.find((item) => item.sku === sku);
    return fit ? [fit] : [];
  });
  return {
    fits,
    eligible: fits.filter((fit) => fit.status === "eligible").map((fit) => fit.sku),
    needsInformation: fits.filter((fit) => fit.status === "needs_information").map((fit) => ({ sku: fit.sku, fields: fit.missing })),
    rejected: fits.filter((fit) => fit.status === "excluded").map((fit) => ({ sku: fit.sku, reasons: fit.blockers })),
    unknownSkus,
  };
}
