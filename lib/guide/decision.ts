import { BUNDLES, KNOWLEDGE_VERSION, MANUAL_SOURCE, PRODUCTS, PRODUCTS_BY_SKU, UNSUPPORTED_POLICY_TOPICS } from "./catalog";
import { fact } from "./state";
import type { DecisionDraft, EvidenceItem, HabitMemory, ProductFit, Recommendation, StateField, UserState } from "./types";

function evidence(id: string, label: string, detail: string, status: EvidenceItem["status"] = "supported"): EvidenceItem {
  return { id, label, detail, source: MANUAL_SOURCE, status };
}

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

function activeCategories(state: UserState): string[] {
  const categories = fact<string[]>(state, "categories") ?? [];
  const targetSku = fact<string>(state, "targetSku");
  if (targetSku && PRODUCTS_BY_SKU[targetSku]) return [PRODUCTS_BY_SKU[targetSku].category];
  return categories;
}

function memoryValue<T extends string | boolean>(memories: HabitMemory[], kind: HabitMemory["kind"]): T | undefined {
  return memories.find((memory) => memory.kind === kind)?.value as T | undefined;
}

export function compileProductFits(state: UserState, memories: HabitMemory[] = []): ProductFit[] {
  const categories = activeCategories(state);
  const skin = fact<string>(state, "skinType");
  const sensitive = fact<boolean>(state, "sensitiveTendency");
  const discomfort = fact<boolean | string>(state, "currentDiscomfort");
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
    if (discomfort === true) blockers.push("当前明显不适时暂停商品推荐");

    if (product.sku === "P101") {
      if (skin === "dry") { matches.push("偏干肤质与手册适用提示一致"); score += 30; }
      if (sensitive === true) { matches.push("敏感倾向且当前稳定时可考虑"); score += 20; }
      if (fragrance === "must_be_fragrance_free" || fragrance === "fragrance_sensitive") { matches.push("无香型符合香味偏好"); score += 18; }
    }
    if (product.sku === "P102") {
      if (skin === "oily") { matches.push("偏油且偏好清爽时可考虑"); score += 30; }
      if (fact<string>(state, "coreConcern") === "fresh_texture") { matches.push("清洁感较强，符合清爽诉求"); score += 12; }
      if (fragrance === "accepts_fragrance") score += 10;
      if (fragrance === "fragrance_sensitive") { tradeoffs.push("带香味，手册提示对香味敏感者不优先"); score -= 25; }
      if (fragrance === "must_be_fragrance_free") blockers.push("用户明确要求无香，而本品带香味");
    }
    if (product.sku === "P201") {
      if (sensitive === true) blockers.push("手册明确不推荐敏感皮肤使用 P201");
      if (discomfort === true || discomfort === "unclear") blockers.push("不适情况未排除，不推荐讨论果酸");
      if (sensitive === undefined) missing.push("sensitiveTendency");
      if (discomfort === undefined) missing.push("currentDiscomfort");
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
      if (fragrance === "accepts_fragrance") score += 8;
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
        evidence(`catalog:${product.sku}`, `${product.sku} 商品事实`, `${product.name} · ¥${(product.priceFen / 100).toFixed(0)} · ${product.features.join("、")}`),
        ...(meaningfulBlockers.length ? [evidence(`gate:${product.sku}`, "资格门禁", meaningfulBlockers.join("；"), "contradicted")] : []),
      ],
    };
  });
}

function questionsFor(fields: StateField[]): StateField[] {
  return [...new Set(fields)].slice(0, 2);
}

function totalFor(skus: readonly string[]) {
  return skus.reduce((sum, sku) => sum + PRODUCTS_BY_SKU[sku].priceFen, 0);
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

export function decide(state: UserState, memories: HabitMemory[] = []): DecisionDraft {
  const fits = compileProductFits(state, memories);
  const draft = baseDraft(fits);
  const discomfort = fact<boolean | string>(state, "currentDiscomfort");
  const intent = fact<string>(state, "intent");
  const targetSku = fact<string>(state, "targetSku");
  const policyTopics = fact<string[]>(state, "policyTopics") ?? [];
  const categories = activeCategories(state);
  const budget = fact<number>(state, "budget");
  const skin = fact<string>(state, "skinType");
  const fragrance = fact<string>(state, "fragrancePreference") ?? memoryValue<string>(memories, "fragrance_preference");

  if (discomfort === true) {
    return {
      ...draft,
      action: "safety",
      route: "safety",
      routeReason: "检测到当前明显不适或受损信息",
      evidence: [evidence("safety:discomfort", "安全边界", "明显不适、受损或持续问题时，停止刺激性尝试并建议咨询专业人士")],
      limitations: ["不作医疗诊断", "本轮不生成商品推荐"],
    };
  }

  if (discomfort === "unclear") {
    return {
      ...draft,
      route: "reasoning",
      routeReason: "不适表述含糊，需要确认是否仍在发生及是否明显",
      questionFields: ["currentDiscomfort"],
      limitations: ["安全信息未明确前不推荐刺激性产品"],
    };
  }

  if (policyTopics.length) {
    const labels = policyTopics.map((topic) => UNSUPPORTED_POLICY_TOPICS[topic] ?? topic);
    const policyEvidence = labels.map((label, index) => evidence(`policy:${policyTopics[index]}`, `${label}政策`, "品牌手册未提供，需要向门店或系统确认", "unknown"));
    if (targetSku && PRODUCTS_BY_SKU[targetSku]) {
      const product = PRODUCTS_BY_SKU[targetSku];
      return { ...draft, action: "policy_unknown", routeReason: "价格有手册依据，政策问题局部待确认", candidateSkus: [targetSku], recommendations: [productRecommendation(targetSku, fits.find((fit) => fit.sku === targetSku))], evidence: [...policyEvidence, evidence(`price:${targetSku}`, `${targetSku} 手册标价`, `¥${product.priceFen / 100}`)], limitations: labels.map((label) => `${label}需要人工确认`) };
    }
    return { ...draft, action: "policy_unknown", routeReason: "手册未覆盖所问政策", evidence: policyEvidence, limitations: labels.map((label) => `${label}需要人工确认`) };
  }

  if (targetSku && PRODUCTS_BY_SKU[targetSku] && intent === "price") {
    const product = PRODUCTS_BY_SKU[targetSku];
    return { ...draft, action: "price_answer", routeReason: "用户询问手册中明确的商品价格", candidateSkus: [targetSku], recommendations: [productRecommendation(targetSku, fits.find((fit) => fit.sku === targetSku))], evidence: [evidence(`price:${targetSku}`, `${targetSku} 手册标价`, `¥${product.priceFen / 100}`)] };
  }

  if (!categories.length) {
    return { ...draft, questionFields: ["categories"], routeReason: "尚未确认需要的商品品类" };
  }

  if (budget !== undefined && categories.length === 1) {
    const products = PRODUCTS.filter((product) => product.category === categories[0]);
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
    const totalFen = totalFor(bundle);
    if (budget < totalFen) {
      return { ...draft, action: "budget_conflict", routeReason: "确定性算价显示组合超过预算", candidateSkus: [...bundle], recommendations: bundle.map((sku) => productRecommendation(sku, fits.find((fit) => fit.sku === sku))), evidence: [evidence(`bundle:${bundle.join("+")}`, "组合算价", bundle.map((sku) => `${sku} ¥${PRODUCTS_BY_SKU[sku].priceFen / 100}`).join(" + ") + ` = ¥${totalFen / 100}`)], totalFen, budgetGapFen: totalFen - budget, pricingMode: "bundle" };
    }
    return { ...draft, action: "recommend", routeReason: "组合满足手册适用条件且在预算内", candidateSkus: [...bundle], recommendations: bundle.map((sku) => productRecommendation(sku, fits.find((fit) => fit.sku === sku))), evidence: [evidence(`bundle:${bundle.join("+")}`, "组合算价", bundle.map((sku) => `${sku} ¥${PRODUCTS_BY_SKU[sku].priceFen / 100}`).join(" + ") + ` = ¥${totalFen / 100}`)], totalFen, pricingMode: "bundle" };
  }

  if (categories.includes("serum")) {
    const fit = fits.find((item) => item.sku === "P201")!;
    if (fit.status === "excluded") return { ...draft, action: "unavailable", routeReason: "P201 未通过安全或经验门槛", evidence: fit.evidence, limitations: fit.blockers };
    if (fit.status === "needs_information") return { ...draft, questionFields: questionsFor(fit.missing as StateField[]), routeReason: "讨论果酸前需确认使用经验与皮肤状态", evidence: fit.evidence };
    return { ...draft, action: "recommend", routeReason: "P201 满足使用经验和当前状态条件", candidateSkus: ["P201"], recommendations: [productRecommendation("P201", fit)], evidence: fit.evidence, totalFen: PRODUCTS_BY_SKU.P201.priceFen, pricingMode: "single" };
  }

  if (categories.includes("travel")) {
    const fit = fits.find((item) => item.sku === "P301")!;
    return { ...draft, action: "recommend", routeReason: "旅行携带需求明确", candidateSkus: ["P301"], recommendations: [productRecommendation("P301", fit)], evidence: fit.evidence, totalFen: PRODUCTS_BY_SKU.P301.priceFen, pricingMode: "single" };
  }

  const category = categories[0] as "cleanser" | "moisturizer";
  if (!skin) return { ...draft, questionFields: ["skinType"], routeReason: "肤质会改变当前品类的优先候选" };
  if (skin === "oily" && fragrance === undefined) return { ...draft, questionFields: ["fragrancePreference"], routeReason: "偏油候选带香，需要确认香味偏好" };

  const eligible = fits.filter((fit) => PRODUCTS_BY_SKU[fit.sku].category === category && fit.status === "eligible" && (budget === undefined || PRODUCTS_BY_SKU[fit.sku].priceFen <= budget)).sort((a, b) => b.score - a.score || PRODUCTS_BY_SKU[a.sku].priceFen - PRODUCTS_BY_SKU[b.sku].priceFen);
  if (!eligible.length) return { ...draft, action: "unavailable", routeReason: "当前硬约束下没有完全匹配的候选", limitations: ["不会把未获手册支持的适用性补成推荐"] };
  const selected = eligible.slice(0, 2);
  return { ...draft, action: "recommend", routeReason: "候选已通过资格门禁并按明确偏好排序", candidateSkus: selected.map((item) => item.sku), recommendations: selected.map((fit) => productRecommendation(fit.sku, fit)), evidence: selected.flatMap((fit) => fit.evidence), ...(selected.length === 1 ? { totalFen: PRODUCTS_BY_SKU[selected[0].sku].priceFen, pricingMode: "single" as const } : { pricingMode: "alternatives" as const }) };
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
