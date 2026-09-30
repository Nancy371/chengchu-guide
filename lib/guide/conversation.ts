import { PRODUCTS_BY_SKU, UNSUPPORTED_POLICY_TOPICS } from "./catalog";
import { fact } from "./state";
import type {
  ConversationAct,
  ConversationBehaviorSkill,
  ConversationPolicy,
  DecisionQuestionField,
  DecisionDraft,
  DecisionResult,
  HabitMemory,
  LifestyleObservation,
  StateField,
  TurnSignal,
  UserState,
} from "./types";

export interface FactSpec {
  locked: boolean;
  requiredLiterals: string[];
  requiredTerms: string[];
  forbidden: string[];
}

export interface FactBlock {
  id: string;
  text: string;
  semanticKey?: string;
  spec: FactSpec;
}

export interface ConversationPlan {
  policy: ConversationPolicy;
  factBlocks: FactBlock[];
  questionGoals: Array<{ field: DecisionQuestionField; fallback: string }>;
  turnContext: {
    previousQuestion?: { field: DecisionQuestionField; text: string };
    confirmedAnswer?: { field: StateField; quote: string; summary: string; acknowledgement: string; anchors: string[] };
    currentAction: DecisionDraft["action"];
    actionAcknowledgement?: { kind: "reject" | "select" | "explain" | "compare"; fallback: string; anchors: string[] };
    nextQuestionGoal?: { field: DecisionQuestionField; text: string };
  };
}

export interface RenderProposal {
  acknowledgement?: string;
  blockIds?: string[];
  factBlocks?: Array<{ id: string; text: string }>;
  questions?: Array<{ field: DecisionQuestionField; text: string }>;
  closing?: string;
  actsUsed?: ConversationAct[];
}

export interface RenderedCopy {
  reply: string;
  questions: string[];
  factBlockIds: string[];
}

const questionCopy: Partial<Record<DecisionQuestionField, string>> = {
  categories: "这次想先看哪一类：洁面、保湿、精华，还是旅行分装呢？",
  budget: "最后再确认一下，这次大概想控制在多少呢？不限预算也可以。",
  giftBoxType: "你想找旅行分装瓶礼盒，还是装护肤品的套装礼盒呢？",
  fragrancePreference: "带一点香味你能接受，还是更想要无香的呢？",
  currentDiscomfort: "先确认一下：现在还有刺痛、疼痛或破损吗？",
  sensitiveTendency: "平时用新护肤品，皮肤容易泛红或刺痛吗？",
  acidExperience: "之前用过果酸或类似的焕肤产品吗？",
  coreConcern: "真要取舍的话，你更想保住清爽肤感、无香，还是价格呢？",
  rejectionReason: "主要是哪一点不合适：价格、香味或洗感，还是想换个方向呢？",
  selectionChoice: "两款里你更想定哪一款呢？",
};

function questionFor(field: DecisionQuestionField, state: UserState, attempt = 1) {
  const followups: Partial<Record<DecisionQuestionField, string[]>> = {
    sensitiveTendency: ["我换个具体的问法：平时用新护肤品基本没反应，还是偶尔会泛红、刺痛？", "如果只说多数时候，皮肤算容易敏感吗？", "你平时会把自己归为敏感皮肤吗？"],
    currentDiscomfort: ["我先确认现在的情况：有没有刺痛、疼痛或破损？", "这些不舒服是现在还有，还是已经好了？", "目前皮肤有破损或明显疼痛吗？"],
    skinType: ["洗完脸更容易紧绷，还是过一会儿容易出油？", "如果只看平时多数时候，脸更偏干还是偏油？", "不用精确判断肤质，日常更常觉得干，还是更常出油？"],
    fragrancePreference: ["带一点香味你能接受吗，还是希望完全无香？", "如果只在带香和无香之间选，你会偏向哪边？", "香味对你是一个限制，还是没有特别要求？"],
    acidExperience: ["之前实际用过果酸或类似焕肤产品吗？", "这类果酸产品你以前亲自用过吗？", "是第一次考虑果酸，还是已经有使用经验？"],
  };
  if (attempt > 1 && followups[field]?.length) return followups[field]![(attempt - 2) % followups[field]!.length];
  if (field !== "skinType") return questionCopy[field] ?? "这点你更偏向哪一边呢？";
  const categories = fact<string[]>(state, "categories") ?? [];
  if (categories.includes("moisturizer")) return "平时皮肤更容易干，还是更容易出油呢？";
  if (categories.includes("serum")) return "平时皮肤更偏干、偏油，还是容易敏感呢？";
  return "洗完脸后，你更容易觉得紧绷，还是过一会儿会出油呢？";
}

export const conversationLanguageRules = [
  "先回应用户这一轮明确说到的处境或感受，再推进购买问题；情绪不明确时只回应处境，不替用户贴标签。",
  "承接只用一句，落到用户原话里的具体处境，不说空泛的‘我理解你的心情’。",
  "追问要像当面聊天：一次只问一个购买决定，优先给容易回答的对比，不把同一个问题换句话再问一遍。",
  "不用‘根据您的需求’‘请问您’‘为了更好地为您服务’‘亲’等客服或表单语言。",
  "不虚构自己的购物或护肤经历，不装熟，不使用催单、制造焦虑或过度热情的表达。",
  "保留事实的范围、条件和不确定性；自然表达不能改写价格、功效、安全边界或政策缺口。",
] as const;

export function formatMoney(fen: number) {
  return `¥${(fen / 100).toFixed(fen % 100 ? 2 : 0)}`;
}

function productLabel(sku: string, name: string) {
  return name.startsWith(`${sku} `) ? name : `${sku} ${name}`;
}

const PRODUCT_TERM_SPECS: Record<string, { required: string[]; forbidden: string[] }> = {
  P101: { required: ["无香", "低泡"], forbidden: ["香味", "淡香", "带香", "泡沫"] },
  P102: { required: ["清洁感", "香味"], forbidden: ["无香", "低泡"] },
  P201: { required: ["果酸", "8%"], forbidden: [] },
  P202: { required: ["无香", "神经酰胺"], forbidden: ["香味", "淡香", "带香"] },
  P203: { required: ["清爽", "淡香"], forbidden: ["无香"] },
  P301: { required: ["分装瓶"], forbidden: [] },
};

const unsafeClaimPattern = /保证|一定有效|治愈|治疗|绝对不过敏|马上见效|闭眼入|必须买|抓紧|最后机会|我也用|我买过|(?:送|赠)(?:小样|礼品|赠品|东西)|赠品|退货|退款|换货|退换|拆封|包邮|正品|授权|淡斑|美白|抗老|祛痘|改善皱纹|手机号|电话|联系方式|地址|收货/;
const skuMoneyPattern = /P[123]\d{2}|[¥￥]/;

const confirmedAnswerTopics: Record<string, RegExp> = {
  intent: /想买|洁面|保湿|精华|分装|礼盒/,
  targetSku: /P[123]\d{2}|洁面|保湿|精华|分装/,
  categories: /洁面|保湿|精华|分装|礼盒|看/,
  budget: /预算|元|价位|花|控制在|多少/,
  budgetScope: /预算|元|价位/,
  skinType: /干|油|肤质|紧绷|出油|敏感/,
  sensitiveTendency: /敏感|泛红|刺痛/,
  currentDiscomfort: /不适|疼|痛|破损|刺痛|红肿/,
  stinging: /刺痛|刺疼/,
  pain: /疼|痛/,
  skinDamage: /破损|受损|屏障/,
  otherDiscomfort: /不适|红肿|不舒服/,
  fragrancePreference: /香/,
  fragranceNote: /香|桂花|玫瑰/,
  acidExperience: /果酸|酸/,
  existingProducts: /在用|手里|现在/,
  travelNeed: /出差|旅行|出行/,
  useOccasions: /出差|旅行|晨间|夜间/,
  texturePreference: /质地|清爽|轻薄|黏/,
  delegateChoice: /定|选|帮/,
  coreConcern: /清爽|无香|价格|肤感/,
  channelPreference: /渠道|门店|线上/,
  claimedOnlinePrice: /价格|线上|同价/,
  giftBoxType: /礼盒|分装|套装/,
  policyTopics: /赠品|退换|促销|授权/,
  rejectionReason: /价格|香味|洗感|方向|不合适/,
  selectionChoice: /选|定|这款|两支/,
};

const actionTopics: Record<string, RegExp> = {
  reject: /排除|不合适|不选|去掉|先放|这款|这支/,
  select: /就按|选|定|这款|这支/,
  explain: /原因|为什么|说清楚|讲|前面/,
  compare: /比|差别|区别|对比|两款/,
};

function productTermSpec(sku: string) {
  return PRODUCT_TERM_SPECS[sku] ?? { required: [], forbidden: [] };
}

function lockedSpec(): FactSpec {
  return { locked: true, requiredLiterals: [], requiredTerms: [], forbidden: [] };
}

function recommendSpec(draft: DecisionDraft): FactSpec {
  const item = draft.recommendations[0];
  if (!item || draft.recommendations.length !== 1) return lockedSpec();
  const termSpec = productTermSpec(item.sku);
  return { locked: false, requiredLiterals: [item.sku, formatMoney(item.priceFen)], requiredTerms: termSpec.required, forbidden: termSpec.forbidden };
}

function explainSpec(sku: string): FactSpec {
  const termSpec = productTermSpec(sku);
  return { locked: false, requiredLiterals: [sku], requiredTerms: termSpec.required, forbidden: termSpec.forbidden };
}

function prohibitedUnsafeText(text: string) {
  return skuMoneyPattern.test(text) || unsafeClaimPattern.test(text);
}

function prohibitedClaims(text: string) {
  return unsafeClaimPattern.test(text);
}

function moneyTokens(text: string) {
  return text.match(/[¥￥]\d+(?:\.\d+)?/g) ?? [];
}

function factBlockValid(text: string, original: FactBlock) {
  const spec = original.spec;
  if (prohibitedClaims(text)) return false;
  if (spec.requiredLiterals.some((literal) => !text.includes(literal))) return false;
  if (spec.requiredTerms.some((term) => !text.includes(term))) return false;
  const originalSkus = new Set(original.text.match(/P[123]\d{2}/g) ?? []);
  const skus = text.match(/P[123]\d{2}/g) ?? [];
  if (skus.some((sku) => !originalSkus.has(sku))) return false;
  const originalMoney = new Set(moneyTokens(original.text));
  const money = moneyTokens(text);
  if (money.some((amount) => !originalMoney.has(amount))) return false;
  return true;
}

function acknowledgesTopic(text: string, regexp?: RegExp) {
  if (!regexp) return true;
  return regexp.test(text);
}

function hasSignal(signals: TurnSignal[], value: TurnSignal["value"]) {
  return signals.some((item) => item.value === value && item.subject !== "other");
}

function firstEmotion(signals: TurnSignal[]) {
  return signals.find((item) => item.kind === "emotion" && item.explicit && item.subject !== "other" && item.temporal !== "historical");
}

function relevantMemory(state: UserState, memories: HabitMemory[], draft: DecisionDraft): HabitMemory | undefined {
  if (!memories.length || !["clarify", "recommend"].includes(draft.action)) return undefined;
  if (!fact(state, "fragrancePreference") && draft.productFits.some((fit) => fit.tradeoffs.some((item) => item.includes("香")))) {
    const fragrance = memories.find((item) => item.kind === "fragrance_preference");
    if (fragrance) return fragrance;
  }
  if (!fact(state, "coreConcern") && activeProductCategories(draft).length > 0) {
    const routine = memories.find((item) => item.kind === "routine_preference");
    if (routine) return routine;
  }
  if (activeProductCategories(draft).some((category) => category === "cleanser" || category === "moisturizer")) {
    const texture = memories.find((item) => item.kind === "texture_preference");
    if (texture) return texture;
  }
  if (draft.pricingMode === "bundle" || draft.pricingMode === "alternatives") return memories.find((item) => item.kind === "purchase_preference");
  return undefined;
}

function activeProductCategories(draft: DecisionDraft) {
  return [...new Set(draft.productFits.filter((fit) => fit.status !== "excluded").map((fit) => PRODUCTS_BY_SKU[fit.sku]?.category).filter(Boolean))];
}

function taskSkill(draft: DecisionDraft, signals: TurnSignal[], state: UserState) : ConversationPolicy["taskSkill"] {
  if (draft.action === "safety") return "discomfort";
  if (hasSignal(signals, "price_objection") || (fact<string[]>(state, "policyTopics") ?? []).includes("online_price")) return "price_objection";
  if (draft.action === "budget_conflict") return "budget_conflict";
  if (hasSignal(signals, "correction")) return "conversation_repair";
  if (hasSignal(signals, "hesitant") || draft.recommendations.length > 1 || ["comparison_only", "product_comparison", "product_explanation", "selection_confirmed", "unavailable", "close"].includes(draft.action)) return "decision_support";
  if (draft.action === "clarify") return "clarification";
  return "recommendation";
}

function selectBehaviorSkills(signals: TurnSignal[], lifestyle: LifestyleObservation[], memory?: HabitMemory, action?: DecisionDraft["action"]): ConversationBehaviorSkill[] {
  if (action === "close" || hasSignal(signals, "reject")) return ["respectful_close"];
  const selected: ConversationBehaviorSkill[] = [];
  if (firstEmotion(signals)) selected.push("emotion_acknowledgement");
  else if (hasSignal(signals, "hurry") || hasSignal(signals, "direct_answer")) selected.push("pace_adaptation");

  if (hasSignal(signals, "simple_routine") || lifestyle.some((item) => item.kind === "routine_preference")) selected.push("routine_fit");
  else if (hasSignal(signals, "existing_routine")) selected.push("existing_routine_respect");
  else if (hasSignal(signals, "morning_rush") || hasSignal(signals, "exercise") || hasSignal(signals, "travel")) selected.push("occasion_fit");
  else if (hasSignal(signals, "sensory_discomfort")) selected.push("sensory_preference");
  else if (memory) selected.push("gentle_recall");
  return selected.slice(0, 2);
}

function acknowledgedEmotion(signals: TurnSignal[], draft: DecisionDraft): ConversationPolicy["userEmotion"] {
  if (draft.action === "safety") return "discomfort";
  const emotion = firstEmotion(signals)?.value;
  return emotion === "worried" || emotion === "frustrated" || emotion === "hesitant" || emotion === "happy" ? emotion : "neutral";
}

function productAngle(sku: string, state: UserState, alternative = false, variant = 0): string {
  const skin = fact<string>(state, "skinType");
  const v = ((variant % 2) + 2) % 2;
  switch (sku) {
    case "P101":
      return !alternative && skin === "dry"
        ? "你说自己偏干，这支无香、低泡，洗后也容易冲净"
        : v === 0 ? "它是无香、低泡的一支，洗后容易冲净" : "这支无香、低泡，洗后容易冲净";
    case "P102":
      return !alternative && skin === "oily"
        ? "你说自己偏油，这支的清洁感较强，不过它带香味"
        : v === 0 ? "它的清洁感较强，也带香味，取向和无香洁面不同" : "这支清洁感较强，也带香味，取向和无香洁面不同";
    case "P201":
      return v === 0 ? "这支含 8% 果酸复合成分；有相关使用经验、希望改善粗糙时可以考虑，使用时要注意防晒" : "它含 8% 果酸复合成分；有相关使用经验、想改善粗糙时可以考虑，使用时要注意防晒";
    case "P202":
      return !alternative && skin === "dry"
        ? "你说自己偏干，这支无香，含神经酰胺类保湿成分"
        : v === 0 ? "它是无香的保湿乳，含神经酰胺类保湿成分" : "这支无香，含神经酰胺类保湿成分";
    case "P203":
      return !alternative && skin === "oily"
        ? "你说自己偏油，这支质地清爽，不过带淡香"
        : v === 0 ? "它是质地清爽、带淡香的一支" : "这支质地清爽，带淡香";
    case "P301":
      return v === 0 ? "你想要出行时带着用的小瓶，这盒有 4 个可重复使用的分装瓶，不是护肤品套装" : "这盒有 4 个可重复使用的分装瓶，适合带着出门，不是护肤品套装";
    default:
      return PRODUCTS_BY_SKU[sku]?.features.join("、") ?? "";
  }
}

function recommendationStory(draft: DecisionDraft, state: UserState, variant = 0): string {
  const [first, second] = draft.recommendations;
  if (!first) return "";
  const firstName = productLabel(first.sku, first.name);
  if (draft.pricingMode === "bundle" && second) {
    return `你这次想把洁面和保湿一起选好，我会把 ${firstName} 和 ${productLabel(second.sku, second.name)} 放在一组：前者${PRODUCTS_BY_SKU[first.sku].features.join("、")}；后者${PRODUCTS_BY_SKU[second.sku].features.join("、")}。两件合计 ${formatMoney(draft.totalFen ?? first.priceFen + second.priceFen)}，可以按实际需要决定是否一起买。`;
  }
  if (draft.pricingMode === "alternatives" && second) {
    return `我会先看 ${firstName}（${formatMoney(first.priceFen)}）：${productAngle(first.sku, state, false, variant)}。${productLabel(second.sku, second.name)}（${formatMoney(second.priceFen)}）则是另一种取向：${productAngle(second.sku, state, true, variant)}；如果这点更合你意，可以选它。`;
  }
  const leads = [
    `我会先看 ${firstName}（${formatMoney(first.priceFen)}）`,
    `先看这款 ${firstName}（${formatMoney(first.priceFen)}）`,
    `结合你刚说的，先看 ${firstName}（${formatMoney(first.priceFen)}）`,
  ];
  const lead = leads[((variant % leads.length) + leads.length) % leads.length];
  return `${lead}：${productAngle(first.sku, state, false, variant)}。`;
}

function lockedBlock(id: string, text: string, semanticKey?: string): FactBlock {
  return { id, text, ...(semanticKey ? { semanticKey } : {}), spec: lockedSpec() };
}

function factsFor(draft: DecisionDraft, state: UserState): FactBlock[] {
  if (draft.action === "safety") return [lockedBlock("safety", "先别继续试新的或刺激性护理；如果疼痛、破损或不适一直没有缓解，建议尽快咨询专业人士。这一轮我先不推荐商品，也不作医疗诊断。")];
  if (draft.action === "close") return [lockedBlock("close", "好，那这次就先停在这里。什么时候想再看看再来，不急。")];
  if (draft.action === "price_list") return [
    lockedBlock("price-list-intro", "预算可以晚点再定。我先把当前能看的商品和实价列出来，你慢慢比较。"),
    ...draft.candidateSkus.flatMap((sku) => {
      const product = PRODUCTS_BY_SKU[sku];
      return product ? [lockedBlock(`price-list:${sku}`, `${productLabel(sku, product.name)}（${product.size}）手册标价 ${formatMoney(product.priceFen)}。`)] : [];
    }),
  ];
  if (draft.action === "policy_unknown") {
    const topics = fact<string[]>(state, "policyTopics") ?? [];
    const targetSku = draft.candidateSkus[0];
    const blocks: FactBlock[] = [];
    if (targetSku && PRODUCTS_BY_SKU[targetSku]) blocks.push(lockedBlock(`price:${targetSku}`, `手册中 ${targetSku} 的标价是 ${formatMoney(PRODUCTS_BY_SKU[targetSku].priceFen)}。`));
    blocks.push(lockedBlock("policy-limit", `品牌手册里没有写明${topics.map((topic) => UNSUPPORTED_POLICY_TOPICS[topic] ?? topic).join("、")}，这点要请门店或系统确认，我先不替他们猜。`));
    return blocks;
  }
  if (draft.action === "price_answer") {
    const item = draft.recommendations[0];
    if (!item) return [];
    return [lockedBlock(`price:${item.sku}`, `${productLabel(item.sku, item.name)}（${PRODUCTS_BY_SKU[item.sku].size}）手册标价是 ${formatMoney(item.priceFen)}。${item.sku === "P102" ? "源文件中的完整名称有缺字，所以没有自行补全。" : ""}`)];
  }
  if (draft.action === "selection_confirmed") {
    const item = draft.recommendations[0];
    return item ? [lockedBlock(`selected:${item.sku}`, `你选的是 ${productLabel(item.sku, item.name)}，手册标价 ${formatMoney(item.priceFen)}。`, "selection:confirmed-product")] : [];
  }
  if (draft.action === "product_explanation") {
    const sku = draft.candidateSkus[0];
    const product = PRODUCTS_BY_SKU[sku];
    const fit = draft.productFits.find((item) => item.sku === sku);
    if (!product || !fit) return [];
    if (fit.status === "excluded" && fit.blockers.length) return [lockedBlock(`explain:${sku}`, `${productLabel(sku, product.name)} 这次没进入推荐，是因为${fit.blockers.join("；")}。`, `explain:${sku}:excluded`)];
    const current = state.purchaseTask?.currentRecommendation?.primarySku;
    const currentProduct = current ? PRODUCTS_BY_SKU[current] : undefined;
    const reason = current && currentProduct && current !== sku
      ? `${productLabel(sku, product.name)} 本身也可以选；只是当时结合你已确认的需求，${productLabel(current, currentProduct.name)} 被放在了前面。${productAngle(sku, state)}。`
      : `${productLabel(sku, product.name)} 的已核实特点是：${product.features.join("、")}。`;
    return [{ id: `explain:${sku}`, semanticKey: `explain:${sku}:tradeoff`, text: reason, spec: explainSpec(sku) }];
  }
  if (draft.action === "product_comparison") return draft.candidateSkus.flatMap((sku) => {
    const product = PRODUCTS_BY_SKU[sku];
    return product ? [lockedBlock(`requested-comparison:${sku}`, `${productLabel(sku, product.name)}（${product.size}）标价 ${formatMoney(product.priceFen)}：${product.features.join("、")}。`, `compare:${sku}`)] : [];
  });
  if (draft.action === "budget_conflict") {
    const budget = fact<number>(state, "budget") ?? 0;
    if (draft.pricingMode === "single" && !draft.recommendations.length) {
      const prices = draft.evidence.filter((item) => item.id.startsWith("price:")).map((item) => `${item.label.replace(" 手册标价", "")} ${item.detail}`).join("、");
      return [lockedBlock("budget-single", `你想把预算控制在 ${formatMoney(budget)} 左右。手册里的相关商品标价是 ${prices}，目前没有预算内的选择，不用为了买而硬加预算。`)];
    }
    return [lockedBlock("budget-bundle", `这套搭配合计 ${formatMoney(draft.totalFen ?? 0)}，比你的 ${formatMoney(budget)} 预算高 ${formatMoney(draft.budgetGapFen ?? 0)}，所以不能把它算成预算内方案。`)];
  }
  if (draft.action === "unavailable") return [lockedBlock("unavailable", draft.routeReason.includes("不愿回答") ? `可以先不回答。${draft.limitations.join("；")}。` : `照你现在说的情况，现有商品里还没有适合直接推荐的。${draft.limitations.length ? `卡在这里：${draft.limitations.join("；")}。` : ""}`)];
  if (draft.action === "comparison_only") return [
    lockedBlock("comparison-intro", "这点偏好还不太确定，我先把两款真正有差别的地方摆出来，你可以先看看。"),
    ...draft.candidateSkus.flatMap((sku) => {
      const product = PRODUCTS_BY_SKU[sku];
      return product ? [lockedBlock(`comparison:${sku}`, `${productLabel(sku, product.name)}（${product.size}）标价 ${formatMoney(product.priceFen)}：${product.features.join("、")}。`)] : [];
    }),
  ];
  if (draft.action === "recommend") {
    const variant = state.turn;
    return [{ id: "recommendation", text: recommendationStory(draft, state, variant), spec: recommendSpec(draft) }];
  }
  return [];
}

function categoryName(value: string) {
  return ({ cleanser: "洁面", moisturizer: "保湿", serum: "果酸精华", travel: "旅行分装" } as Record<string, string>)[value] ?? value;
}

function confirmedAnswerFor(state: UserState, updatedFields: StateField[], previousResult?: DecisionResult | null) {
  const preferred = previousResult?.questionFields[0];
  const priority: StateField[] = [
    ...(preferred && preferred !== "rejectionReason" && preferred !== "selectionChoice" ? [preferred] : []),
    "budget", "skinType", "fragrancePreference", "currentDiscomfort", "sensitiveTendency", "acidExperience", "categories", "giftBoxType", "coreConcern", "texturePreference",
  ];
  const field = priority.find((item) => updatedFields.includes(item) && state.facts[item]?.status === "confirmed");
  if (!field) return undefined;
  const source = state.facts[field]!;
  const value = source.value;
  if (field === "budget" && typeof value === "number") {
    const amount = String(value / 100);
    return { field, quote: source.quote, summary: `预算 ${amount} 元`, acknowledgement: `好，先按 ${amount} 元看。`, anchors: [amount] };
  }
  if (field === "skinType") {
    const label = value === "dry" ? "更容易干或紧绷" : value === "oily" ? "更容易出油" : "肤质还不确定";
    return { field, quote: source.quote, summary: label, acknowledgement: `好，${label}这点我记下了。`, anchors: [value === "dry" ? "干" : value === "oily" ? "油" : "不确定"] };
  }
  if (field === "fragrancePreference") {
    const label = value === "must_be_fragrance_free" ? "希望无香" : value === "fragrance_sensitive" ? "对香味敏感" : value === "accepts_fragrance" ? "能接受香味" : "香味都可以";
    return { field, quote: source.quote, summary: label, acknowledgement: `嗯，${label}，我记下了。`, anchors: [value === "must_be_fragrance_free" ? "无香" : "香味"] };
  }
  if (field === "currentDiscomfort") {
    const clear = value === false;
    return { field, quote: source.quote, summary: clear ? "目前没有不适" : "目前仍有不适", acknowledgement: clear ? "好，现在没有不适。" : "听起来现在脸还不太舒服。", anchors: [clear ? "没有不适" : "不舒服"] };
  }
  if (field === "sensitiveTendency") {
    const label = value === true ? "平时容易敏感" : "平时不太敏感";
    return { field, quote: source.quote, summary: label, acknowledgement: `好，${label}。`, anchors: ["敏感"] };
  }
  if (field === "acidExperience") {
    const used = value === true;
    return { field, quote: source.quote, summary: used ? "用过果酸" : "没有用过果酸", acknowledgement: used ? "好，之前用过果酸。" : "好，这次按第一次接触果酸来考虑。", anchors: ["果酸"] };
  }
  if (field === "categories" && Array.isArray(value)) {
    const label = value.map(categoryName).join("和");
    return { field, quote: source.quote, summary: `这次先看${label}`, acknowledgement: `好，这次先看${label}。`, anchors: value.map(categoryName) };
  }
  if (field === "giftBoxType") {
    const label = value === "travel_kit" ? "旅行分装瓶礼盒" : "护肤品礼盒";
    return { field, quote: source.quote, summary: label, acknowledgement: `好，先按${label}找。`, anchors: ["礼盒"] };
  }
  return { field, quote: source.quote, summary: source.quote, acknowledgement: "好，这点我记下了。", anchors: [] };
}

function acknowledgementFor(plan: ConversationPlan, signals: TurnSignal[]) {
  const policy = plan.policy;
  if (plan.turnContext.actionAcknowledgement) return plan.turnContext.actionAcknowledgement.fallback;
  if (policy.userEmotion === "discomfort") return "听起来现在脸不太舒服。";
  if (policy.taskSkill === "conversation_repair" && policy.behaviorSkills.includes("routine_fit")) return plan.turnContext.confirmedAnswer ? `刚才是我听偏了，${plan.turnContext.confirmedAnswer.summary}，也尽量少加步骤。` : "刚才是我听偏了。这次按你新说的方向来，也尽量少加步骤。";
  if (policy.taskSkill === "conversation_repair") return plan.turnContext.confirmedAnswer ? `刚才是我听偏了，${plan.turnContext.confirmedAnswer.summary}。` : "刚才是我听偏了，按你新补充的情况重新看。";
  if (policy.taskSkill === "price_objection") return "差价摆在这儿，想问清楚很正常。";
  if (policy.userEmotion === "frustrated") return "选了半天确实挺累，我们先把范围收小。";
  if (policy.userEmotion === "worried") return "这个顾虑得先说清楚，免得买回去不合适。";
  if (policy.userEmotion === "hesitant") return "这几个放在一起确实不太好选，我帮你把差别压到最关键的一点。";
  if (policy.userEmotion === "happy") return "好，这下方向清楚多了。";
  if (plan.turnContext.confirmedAnswer) return plan.turnContext.confirmedAnswer.acknowledgement;
  if (policy.behaviorSkills.includes("routine_fit")) return "那就按简单省事来，不给你添步骤。";
  if (policy.behaviorSkills.includes("occasion_fit") && hasSignal(signals, "morning_rush")) return "早上时间紧，我们就挑关键的说。";
  if (policy.behaviorSkills.includes("existing_routine_respect")) return "手里的先用好，这次只补真正缺的。";
  if (policy.behaviorSkills.includes("gentle_recall") && policy.usedMemory) return "我会参考你之前保存的偏好；要是变了，直接纠正我就行。";
  if (policy.nextAction === "price_answer") return "好，先看你刚问的价格。";
  if (policy.nextAction === "policy_unknown") return "好，先把这件事说清楚。";
  if (policy.nextAction === "recommend") return "好，方向已经清楚了。";
  if (policy.nextAction === "clarify") return "好，我们接着往下看。";
  return "好，按你刚说的来。";
}

export function planConversation(input: {
  draft: DecisionDraft;
  state: UserState;
  signals: TurnSignal[];
  lifestyle: LifestyleObservation[];
  memories: HabitMemory[];
  previousResult?: DecisionResult | null;
  updatedFields: StateField[];
  questionAttempt?: number;
}): ConversationPlan {
  const { draft, state, signals, lifestyle, memories, previousResult, questionAttempt, updatedFields } = input;
  const memory = relevantMemory(state, memories, draft);
  const rejected = hasSignal(signals, "reject");
  const effectiveDraft: DecisionDraft = rejected && draft.action !== "safety" ? { ...draft, action: "close", recommendations: [], candidateSkus: [], totalFen: undefined, budgetGapFen: undefined, routeReason: "用户明确表示停止推荐或暂不购买" } : draft;
  const selectedQuestionFields = effectiveDraft.action === "clarify"
    ? effectiveDraft.questionFields.slice(0, 1)
    : [];
  const emotion = acknowledgedEmotion(signals, effectiveDraft);
  const behaviorSkills = selectBehaviorSkills(signals, lifestyle, memory, effectiveDraft.action);
  const task = taskSkill(effectiveDraft, signals, state);
  const shouldAcknowledge = true;
  const acts: ConversationAct[] = [
    ...(shouldAcknowledge ? ["acknowledge" as const] : []),
    ...(effectiveDraft.action === "budget_conflict" || effectiveDraft.action === "close" ? ["reduce_pressure" as const] : []),
    ...(effectiveDraft.action === "policy_unknown" || effectiveDraft.action === "unavailable" ? ["state_limit" as const] : ["state_fact" as const]),
    ...(selectedQuestionFields.length ? ["ask_question" as const] : []),
    ...(task === "conversation_repair" ? ["repair_understanding" as const] : []),
    ...(effectiveDraft.action === "close" ? ["close_respectfully" as const] : []),
  ];
  const calm = effectiveDraft.action === "safety" || effectiveDraft.action === "close" || emotion === "frustrated" || hasSignal(signals, "hurry");
  const policy: ConversationPolicy = {
    taskSkill: task,
    behaviorSkills,
    userEmotion: emotion,
    relationshipStage: task === "conversation_repair" ? "repair" : state.turn <= 1 ? "early" : effectiveDraft.action === "clarify" ? "exploring" : "evaluating",
    nextAction: effectiveDraft.action,
    conversationActs: [...new Set(acts)],
    tone: calm ? "calm_direct" : "light_warm",
    pressureLevel: "low",
    selectedQuestionFields,
    responseLength: calm || hasSignal(signals, "direct_answer") ? "short" : "medium",
    shouldAcknowledge,
    shouldExplainReason: false,
    emojiPolicy: !calm && state.turn <= 1 && ["clarify", "recommend"].includes(effectiveDraft.action) ? "optional_one" : "none",
    acknowledgedSignal: firstEmotion(signals) ?? signals.find((item) => item.explicit && item.subject !== "other" && item.temporal !== "historical" && ["price_objection", "correction", "hurry", "simple_routine", "existing_routine"].includes(item.value)),
    usedMemory: memory ? { id: memory.id, kind: memory.kind, value: memory.value } : undefined,
  };
  const questionGoals = selectedQuestionFields.map((field) => ({ field, fallback: questionFor(field, state, questionAttempt ?? (previousResult?.questionFields.includes(field) ? 2 : 1)) }));
  const confirmedAnswer = confirmedAnswerFor(state, updatedFields, previousResult);
  const turnAction = state.purchaseTask?.turnAction.kind;
  const actionAcknowledgement = turnAction === "reject_current"
    ? { kind: "reject" as const, fallback: "好，这款先排除。", anchors: ["排除", "不合适"] }
    : effectiveDraft.action === "selection_confirmed"
      ? { kind: "select" as const, fallback: "好，就按这款。", anchors: ["就按", "选"] }
      : effectiveDraft.action === "product_explanation"
        ? { kind: "explain" as const, fallback: "好，我把它没排在前面的原因说清楚。", anchors: ["原因", "说清楚"] }
        : effectiveDraft.action === "product_comparison"
          ? { kind: "compare" as const, fallback: "好，我们只比这两款的实际差别。", anchors: ["比", "差别", "对比"] }
          : undefined;
  return {
    policy,
    factBlocks: [
      ...factsFor(effectiveDraft, state),
    ],
    questionGoals,
    turnContext: {
      ...(previousResult?.questionFields[0] && previousResult.questions?.[0] ? { previousQuestion: { field: previousResult.questionFields[0], text: previousResult.questions[0] } } : {}),
      ...(confirmedAnswer ? { confirmedAnswer } : {}),
      currentAction: effectiveDraft.action,
      ...(actionAcknowledgement ? { actionAcknowledgement } : {}),
      ...(questionGoals[0] ? { nextQuestionGoal: { field: questionGoals[0].field, text: questionGoals[0].fallback } } : {}),
    },
  };
}

function usesUnauthorizedNumber(text: string, plan: ConversationPlan) {
  const allowed = new Set(plan.turnContext.confirmedAnswer?.summary.match(/\d+(?:\.\d+)?/g) ?? []);
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).some((number) => !allowed.has(number));
}

function emojiCount(text: string) {
  return (text.match(/[\p{Extended_Pictographic}]/gu) ?? []).length;
}

function claimsUnselectedGap(text: string, selectedFields: DecisionQuestionField[]) {
  const missingClaim = /(?:还没|没有|没|尚未|未)(?:说|提|提到|明确|确定|说明|告诉)/;
  if (!missingClaim.test(text)) return false;
  const selected = new Set(selectedFields);
  if (/(?:哪类|品类|类别|产品类型|想买什么)/.test(text) && !selected.has("categories")) return true;
  if (/预算|价位|花多少/.test(text) && !selected.has("budget")) return true;
  if (/肤质|偏干|偏油/.test(text) && !selected.has("skinType")) return true;
  if (/香味|无香/.test(text) && !selected.has("fragrancePreference")) return true;
  if (/质地|肤感/.test(text) && !selected.has("texturePreference")) return true;
  if (/不适|刺痛|破损|疼痛/.test(text) && !selected.has("currentDiscomfort")) return true;
  return false;
}

export function validateRenderProposal(value: unknown, plan: ConversationPlan): RenderedCopy | null {
  if (!value || typeof value !== "object") return null;
  const proposal = value as RenderProposal;
  const requiredIds = plan.factBlocks.map((block) => block.id);
  if (!Array.isArray(proposal.blockIds) || proposal.blockIds.length !== requiredIds.length || proposal.blockIds.some((id, index) => id !== requiredIds[index])) return null;
  const originalById = new Map(plan.factBlocks.map((block) => [block.id, block]));
  const blockTextById = new Map(plan.factBlocks.map((block) => [block.id, block.text]));
  if (proposal.factBlocks !== undefined) {
    if (!Array.isArray(proposal.factBlocks) || proposal.factBlocks.length !== requiredIds.length) return null;
    for (const entry of proposal.factBlocks) {
      if (!entry || typeof entry.id !== "string" || typeof entry.text !== "string") return null;
      const original = originalById.get(entry.id);
      if (!original) return null;
      const text = entry.text.trim();
      if (!text) return null;
      if (original.spec.locked ? text !== original.text : !factBlockValid(text, original)) return null;
      blockTextById.set(entry.id, text);
    }
  }
  const acknowledgement = typeof proposal.acknowledgement === "string" ? proposal.acknowledgement.trim() : "";
  const closing = typeof proposal.closing === "string" ? proposal.closing.trim() : "";
  if (plan.policy.shouldAcknowledge && !acknowledgement) return null;
  if (acknowledgement.length > 140 || closing.length > 140 || prohibitedUnsafeText(`${acknowledgement}${closing}`) || /[？?]/.test(`${acknowledgement}${closing}`)) return null;
  if (usesUnauthorizedNumber(`${acknowledgement}${closing}`, plan)) return null;
  if (plan.turnContext.confirmedAnswer && !acknowledgesTopic(acknowledgement, confirmedAnswerTopics[plan.turnContext.confirmedAnswer.field])) return null;
  if (plan.turnContext.actionAcknowledgement && !acknowledgesTopic(acknowledgement, actionTopics[plan.turnContext.actionAcknowledgement.kind])) return null;
  if (plan.turnContext.actionAcknowledgement?.kind === "reject" && /(?:换一|另一|新的|更温和|更清爽|改推)/.test(acknowledgement)) return null;
  if (!["recommend", "product_comparison"].includes(plan.policy.nextAction) && /(?:换一支|另一款|新推荐)/.test(`${acknowledgement}${closing}`)) return null;
  const semanticKeys = plan.factBlocks.map((block) => block.semanticKey ?? block.id);
  if (new Set(semanticKeys).size !== semanticKeys.length) return null;
  if (claimsUnselectedGap(`${acknowledgement}${closing}`, plan.policy.selectedQuestionFields)) return null;
  if (plan.policy.nextAction === "comparison_only" && /推荐|主推|首选|适合|先选|先看|值得买|入手/.test(`${acknowledgement}${closing}`)) return null;
  const questions = Array.isArray(proposal.questions) ? proposal.questions : [];
  if (questions.length !== plan.policy.selectedQuestionFields.length) return null;
  if (plan.policy.nextAction === "clarify" && closing) return null;
  for (const question of questions) {
    if (!question || !plan.policy.selectedQuestionFields.includes(question.field) || typeof question.text !== "string" || !question.text.trim() || question.text.length > 140 || prohibitedUnsafeText(question.text) || usesUnauthorizedNumber(question.text, plan)) return null;
    if ((question.text.match(/[？?]/g) ?? []).length !== 1) return null;
  }
  const freeText = [acknowledgement, ...questions.map((item) => item.text), closing].join("");
  if (plan.policy.emojiPolicy === "none" && emojiCount(freeText) > 0) return null;
  if (plan.policy.emojiPolicy === "optional_one" && emojiCount(freeText) > 1) return null;
  const parts = [acknowledgement, ...proposal.blockIds.map((id) => blockTextById.get(id) ?? ""), ...questions.map((item) => item.text.trim()), closing].filter(Boolean);
  const reply = parts.join(" ");
  if (!reply || reply.length > 600) return null;
  return { reply, questions: questions.map((item) => item.text.trim()), factBlockIds: proposal.blockIds };
}

export function renderTemplate(plan: ConversationPlan, signals: TurnSignal[]): RenderedCopy {
  const acknowledgement = plan.policy.shouldAcknowledge ? acknowledgementFor(plan, signals) : "";
  const questions = plan.questionGoals.map((item) => item.fallback);
  const closing = plan.policy.nextAction === "clarify" && !questions.length ? "先不重复问了，你想起别的信息时再接着说就好。" : "";
  const parts = [acknowledgement, ...plan.factBlocks.map((block) => block.text), ...questions, closing].filter(Boolean);
  return { reply: parts.join(" "), questions, factBlockIds: plan.factBlocks.map((block) => block.id) };
}
