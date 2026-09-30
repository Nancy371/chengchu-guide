import { PRODUCTS_BY_SKU } from "./catalog";
import type { FactValue, LifestyleObservation, PurchaseTurnAction, SignalKind, SignalValue, SkuMention, SourcedFact, StateDelta, StateField, TurnSignal, TurnUnderstanding, UserState } from "./types";

export const EMPTY_STATE: UserState = { facts: {}, history: [], turn: 0 };

const fields = new Set<StateField>([
  "intent", "targetSku", "categories", "budget", "budgetScope", "skinType",
  "sensitiveTendency", "currentDiscomfort", "fragrancePreference", "fragranceNote", "acidExperience",
  "stinging", "pain", "skinDamage", "otherDiscomfort",
  "existingProducts", "travelNeed", "useOccasions", "texturePreference", "delegateChoice", "coreConcern", "channelPreference",
  "claimedOnlinePrice", "policyTopics",
  "giftBoxType",
]);

export function isStateField(value: unknown): value is StateField {
  return typeof value === "string" && fields.has(value as StateField);
}

function update(field: StateField, value: FactValue, text: string, status: "confirmed" | "unclear" = "confirmed") {
  return { field, value, quote: text, status, extractedBy: "local" as const };
}

function chineseBudgetAmount(value: string): number | undefined {
  const digits: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  const hundreds = value.match(/^([一二两三四五六七八九])百(?:([一二两三四五六七八九])十?([一二两三四五六七八九])?)?$/);
  if (hundreds) {
    const hundred = digits[hundreds[1]] * 100;
    if (!hundreds[2]) return hundred;
    if (value.includes("十")) return hundred + digits[hundreds[2]] * 10 + (hundreds[3] ? digits[hundreds[3]] : 0);
    return hundred + digits[hundreds[2]] * 10;
  }
  const tens = value.match(/^([一二两三四五六七八九])?十([一二两三四五六七八九])?$/);
  if (tens) return (tens[1] ? digits[tens[1]] : 1) * 10 + (tens[2] ? digits[tens[2]] : 0);
  return digits[value];
}

function pendingBudgetAnswer(text: string): number | undefined {
  const compact = text.trim().replace(/\s+/g, "").replace(/[，。！？?!,]/g, "");
  const wrapper = compact.match(/^(?:预算)?(?:大概|大约|差不多|就|控制在)?[¥￥]?(.+?)(?:元|块钱|块)?(?:左右|以内|以下|上下)?(?:吧|就行|可以)?$/);
  if (!wrapper) return undefined;
  if (/^[1-9]\d{0,4}$/.test(wrapper[1])) return Number(wrapper[1]) * 100;
  const chinese = chineseBudgetAmount(wrapper[1]);
  return chinese === undefined ? undefined : chinese * 100;
}

const symptomFields = ["stinging", "pain", "skinDamage", "otherDiscomfort"] as const;
type SymptomField = typeof symptomFields[number];

function symptomUpdates(text: string): StateDelta["updates"] {
  const compact = text.replace(/\s+/g, "");
  if (subjectFor(compact) === "other") return [];
  // A past episode is not a current symptom. A following explicit present-time
  // clause can still report a new symptom or recovery.
  const present = /(?:以前|曾经|过去|之前|去年|上次)/.test(compact)
    ? compact.match(/(?:现在|目前|如今|今天|这次|最近)[^，。；;]*/)?.[0] ?? ""
    : compact;
  const result: StateDelta["updates"] = [];
  const rules: Array<[SymptomField, RegExp, RegExp]> = [
    ["stinging", /(?:没有|没|无|不)(?:明显)?(?:刺痛|刺疼)|刺痛(?:已经)?(?:好了|消失|恢复)/, /刺痛|刺疼|灼痛/],
    ["pain", /(?:没有|没|无|不)(?:明显)?(?:疼痛|疼|痛)|(?:疼痛|疼)(?:已经)?(?:好了|消失|恢复)/, /很疼|脸疼|疼痛|还在疼|脸很痛|疼得|有点疼|又疼/],
    ["skinDamage", /(?:没有|没|无|不)(?:明显)?(?:破损|受损)|(?:破损|受损)(?:已经)?(?:好了|恢复|愈合)/, /皮肤破损|破损|受损|屏障受损/],
    ["otherDiscomfort", /(?:没有|没|无|不)(?:明显)?(?:不适|不舒服|红肿)|(?:不适|红肿)(?:已经)?(?:好了|消失|恢复)/, /红肿|持续不适|明显不适|仍有不适|正在不适|不舒服/],
  ];
  const recoveryPattern = /(?:已经|现在|目前|完全)?(?:恢复了?|好了|都好了|没事了?|无不适|没有不适|状态稳定|目前稳定)/;
  const globalRecovery = /无不适|没有不适/.test(present) ||
    (!/(?:刺痛|刺疼|破损|受损|疼|痛|红肿|不适)/.test(present) && recoveryPattern.test(present));
  for (const [field, negative, positive] of rules) {
    const neg = present.match(negative);
    const stripped = present.replace(negative, "");
    const pos = stripped.match(positive);
    if (pos) result.push(update(field, field === "otherDiscomfort" && /不舒服/.test(pos[0]) && !/红肿|持续/.test(pos[0]) ? "unclear" : true, pos[0], field === "otherDiscomfort" && /不舒服/.test(pos[0]) && !/红肿|持续/.test(pos[0]) ? "unclear" : "confirmed"));
    else if (neg) result.push(update(field, false, neg[0]));
    else if (globalRecovery) result.push(update(field, false, present.match(recoveryPattern)?.[0] ?? present));
  }
  return result;
}

export function deterministicExtract(text: string): StateDelta {
  const raw = text.trim();
  const compact = raw.replace(/\s+/g, "");
  const updates: StateDelta["updates"] = [];
  const categories: string[] = [];
  if (/洗面奶|洁面/.test(compact)) categories.push("cleanser");
  if (/保湿|面霜|乳液|凝露/.test(compact)) categories.push("moisturizer");
  if (/精华|果酸|粗糙|焕肤/.test(compact)) categories.push("serum");
  if (/分装|小瓶|出差|旅行/.test(compact)) categories.push("travel");
  if (/只买.*(?:洁面|洗面奶)/.test(compact)) categories.splice(0, categories.length, "cleanser");
  if (/只买.*(?:保湿|面霜|乳液|凝露)/.test(compact)) categories.splice(0, categories.length, "moisturizer");
  if (/旅行.*礼盒|分装.*礼盒|礼盒.*(?:旅行|分装)/.test(compact)) categories.splice(0, categories.length, "travel");
  if (categories.length) updates.push(update("categories", [...new Set(categories)], raw));
  if (/旅行.*礼盒|分装.*礼盒|礼盒.*(?:旅行|分装)/.test(compact)) updates.push(update("giftBoxType", "travel_kit", raw));
  else if (/护肤(?:品)?礼盒|护肤套装礼盒/.test(compact)) updates.push(update("giftBoxType", "skincare_gift_box", raw));

  const targetMention = classifySkuMentions(raw).find((mention) => mention.role === "target");
  if (targetMention) updates.push(update("targetSku", targetMention.sku, targetMention.quote));

  const policyTopics: string[] = [];
  if (/促销|优惠|活动/.test(compact)) policyTopics.push("promotion");
  if (/赠品|送什么|送东西/.test(compact)) policyTopics.push("gift");
  if (/同价|补差价|(?:网上|线上|淘宝|京东|拼多多).*(?:便宜|低)|为什么.*贵|差价/.test(compact)) policyTopics.push("online_price");
  if (/退换|退货|换货/.test(compact)) policyTopics.push("return");
  if (/授权|正品|真假|假货/.test(compact)) policyTopics.push("authorization");
  if (policyTopics.length) updates.push(update("policyTopics", [...new Set(policyTopics)], raw));

  const priceQuestion = /多少钱|价格|售价|贵不贵/.test(compact);
  const wantsRecommendation = /想买|推荐|适合|考虑|要一套|只买|给我选/.test(compact) || categories.length > 0;
  updates.push(update("intent", policyTopics.length ? "policy" : priceQuestion ? "price" : wantsRecommendation ? "recommend" : "clarify", raw));

  const budgetCorrection = compact.match(/(?:预算)?(?:从[¥￥]?[1-9]\d{1,4})?(?:改成|改为|调整为|提高到|降到)[¥￥]?([1-9]\d{1,4})/);
  const budgetMatch = budgetCorrection ?? compact.match(/(?:预算|总预算|最多|到|不超过|控制在|可以到)(?:大概|大约|约|是|为)?[¥￥]?([1-9]\d{1,4})(?:左右)?/);
  if (budgetMatch) updates.push(update("budget", Number(budgetMatch[1]) * 100, raw));
  if (/总预算|一共|合计/.test(compact)) updates.push(update("budgetScope", "total", raw));
  else if (/单品|只买/.test(compact)) updates.push(update("budgetScope", "current_item", raw));

  const claimedPrice = compact.match(/(?:网上|线上|网店).*?[¥￥]?([1-9]\d{1,4})/);
  if (claimedPrice) updates.push(update("claimedOnlinePrice", Number(claimedPrice[1]) * 100, raw));

  const drySkin = /偏干|干皮|干性(?:皮肤|肌肤)|干燥|洗后紧绷/.test(compact);
  const oilySkin = /偏油|油皮|油性(?:皮肤|肌肤)|(?<!不|没)出油/.test(compact);
  if (drySkin !== oilySkin) updates.push(update("skinType", drySkin ? "dry" : "oily", raw));

  if (/没有敏感|不敏感/.test(compact)) updates.push(update("sensitiveTendency", false, raw));
  else if (/敏感肌|容易敏感|敏感倾向|皮肤敏感/.test(compact)) updates.push(update("sensitiveTendency", true, raw));

  const symptoms = symptomUpdates(raw);
  updates.push(...symptoms);
  if (symptoms.some((item) => item.value === true)) updates.push(update("currentDiscomfort", true, raw));
  else if (symptoms.some((item) => item.value === "unclear")) updates.push(update("currentDiscomfort", "unclear", raw, "unclear"));
  else if (symptoms.length === symptomFields.length && symptoms.every((item) => item.value === false) && /(?:没有不适|无不适|现在没事|目前稳定|状态稳定|已经恢复|完全好了|都好了)/.test(compact)) updates.push(update("currentDiscomfort", false, raw));

  const currentPreference = /(?:以前|曾经|过去|之前|去年|上次)/.test(compact)
    ? compact.match(/(?:现在|目前|这次)[^，。；;]*/)?.[0] ?? "" : compact;
  if (subjectFor(compact) === "self" && currentPreference) {
    if (/必须.*无香|一点香味都没有|不要香味|只要无香|只喜欢无香/.test(currentPreference)) updates.push(update("fragrancePreference", "must_be_fragrance_free", raw));
    else if (/对香味敏感|闻不了香|香味敏感/.test(currentPreference)) updates.push(update("fragrancePreference", "fragrance_sensitive", raw));
    else if (/(?:香味|香气|味道).{0,3}(?:都可以|无所谓|随便)/.test(currentPreference)) updates.push(update("fragrancePreference", "no_preference", raw));
    else if (/可以接受香味|能接受香味|喜欢香味|带香.*可以|(?:喜欢|偏爱)[^，。]{0,8}(?:香|香味)/.test(currentPreference) && !/不喜欢|无香|不接受|讨厌|受不了/.test(currentPreference)) updates.push(update("fragrancePreference", "accepts_fragrance", raw));
  }

  if (subjectFor(compact) === "self" && currentPreference && !/(?:不喜欢|讨厌|受不了)/.test(currentPreference)) {
    const note = currentPreference.match(/(?:喜欢|偏爱|偏好)([^，。；;！？!?]{1,10}香)/)?.[1];
    if (note && !/^(?:香|味|带香)/.test(note)) updates.push(update("fragranceNote", note, raw));
  }
  if (/你帮我(?:定|选|挑)(?:一款|一个|吧)?|你来帮我选|直接帮我选/.test(compact)) updates.push(update("delegateChoice", true, raw));

  if (/没用过果酸|第一次用果酸|没有.*果酸.*经验/.test(compact)) updates.push(update("acidExperience", false, raw));
  else if (/用过果酸|果酸.*很多年|有.*焕肤.*经验|有.*果酸.*经验/.test(compact)) updates.push(update("acidExperience", true, raw));

  if (/保湿.*还(?:有|很多)|已经有.*保湿|家里有.*保湿/.test(compact)) updates.push(update("existingProducts", ["moisturizer"], raw));
  if (/出差|旅行|旅游|随身携带|分装/.test(compact)) updates.push(update("travelNeed", true, raw));
  const occasions: string[] = [];
  if (/早上.*赶|早晨.*赶|晨间.*赶|赶着上班/.test(compact)) occasions.push("morning_rush");
  if (/运动后|健身后|跑步后|游泳后/.test(compact)) occasions.push("exercise");
  if (/出差|旅行|旅游/.test(compact)) occasions.push("travel");
  if (occasions.length) updates.push(update("useOccasions", occasions, raw));
  if (subjectFor(compact) === "self" && currentPreference) {
    if (/不喜欢黏|讨厌黏|不要黏|(?<!不|没)喜欢轻薄|(?<!不|没)喜欢清爽/.test(currentPreference)) updates.push(update("texturePreference", "lightweight", raw));
    if (/洗后紧绷|洗完.*紧绷|洗完.*拔干/.test(currentPreference)) updates.push(update("texturePreference", "avoid_tightness", raw));
    if (/(?:质地|肤感).{0,3}(?:都可以|无所谓|随便)/.test(currentPreference)) updates.push(update("texturePreference", "no_preference", raw));
  }
  if (/粗糙/.test(compact)) updates.push(update("coreConcern", "roughness", raw));
  if (/清爽|轻薄/.test(compact)) updates.push(update("coreConcern", "fresh_texture", raw));
  if (/简单护理|精简护理/.test(compact)) updates.push(update("coreConcern", "simple_routine", raw));

  return { updates, extraction: "local", warnings: [] };
}

function subjectFor(text: string): TurnSignal["subject"] {
  return /(?:给|帮)(?:我)?(?:妈妈|妈|爸爸|爸|朋友|对象|同事)|替别人|帮别人/.test(text) ? "other" : "self";
}

function signal(kind: SignalKind, value: SignalValue, quote: string, subject: TurnSignal["subject"], explicit = true, temporal: TurnSignal["temporal"] = "current"): TurnSignal {
  return { kind, value, quote, subject, explicit, temporal };
}

function isExplicitRejection(text: string) {
  if (/不要了|不买了|别推荐|不用推荐|不想买|先不买/.test(text)) return true;
  if (!/算了/.test(text)) return false;
  return !/(?:还是|改成|改为|只看|看看|想看|想买|推荐|洁面|洗面奶|保湿|面霜|乳液|精华|分装)/.test(text);
}

export function classifyPurchaseAction(text: string, pendingQuestion?: StateField): PurchaseTurnAction {
  const compact = text.replace(/\s+/g, "");
  const mentions = classifySkuMentions(text);
  const withMentions = (action: Omit<PurchaseTurnAction, "mentions">): PurchaseTurnAction => ({ ...action, ...(mentions.length ? { mentions } : {}) });
  if (/不要了|不买了|别推荐|不用推荐|不想买|先不买/.test(compact)) return { kind: "end", quote: text };
  if (/不想回答|不愿意回答|不方便说|不想说|别再问|别问了/.test(compact) || (pendingQuestion === "budget" && /还没想好|先看看|先看(?:看)?价格|暂时没想预算/.test(compact))) return { kind: "decline_answer", quote: text };
  if (mentions.some((item) => item.role === "selection")) return withMentions({ kind: "select_product", quote: text });
  if (/为什么.*(?:不|没).*(?:推荐|选)|怎么.*(?:不|没).*(?:推荐|选)|(?:不推荐|没推荐).*(?:为什么|原因)/.test(compact)) return withMentions({ kind: "ask_why_not", quote: text, topic: "fit_reason" });
  if (/上一款|刚才那款|前一款/.test(compact) && /比|比较|区别|不同/.test(compact) || mentions.filter((item) => item.role === "comparison").length >= 2) return withMentions({ kind: "compare_with_previous", quote: text });
  const productReference = mentions.length > 0 || /这款|这一款|它|刚才(?:推荐)?的/.test(compact);
  if (productReference && /多少钱|价格|售价|贵不贵/.test(compact)) return withMentions({ kind: "ask_about_product", quote: text, topic: "price" });
  if (productReference && /促销|优惠|活动|赠品|退换|授权|正品|真假/.test(compact)) return withMentions({ kind: "ask_about_product", quote: text, topic: "policy" });
  if (/(?:这款|这一款|这个|它)(?:很|挺)?(?:合适|可以|不错|挺好)|(?:接受|选|要)(?:这款|这一款|这个|它)/.test(compact) && !/(?:不合适|不可以|不接受|不选|不要)/.test(compact)) return withMentions({ kind: "accept_current", quote: text });
  if (mentions.some((item) => item.role === "rejection") || productReference && /不合适|不太合适|不喜欢|不要(?:这|它)|不选/.test(compact)) return withMentions({ kind: "reject_current", quote: text });
  if (/还有(?:其他|别的).*(?:推荐|选择|款)|(?:换|看)(?:一个|一款|别的)|别的呢|其他呢/.test(compact)) return withMentions({ kind: "request_alternative", quote: text });
  if (/礼盒/.test(compact) && !/赠品/.test(compact)) return { kind: "switch_goal", quote: text };
  if (/想买|只买|改成|改看|换成|还是看|要一套|给我选/.test(compact) && /洗面奶|洁面|保湿|面霜|乳液|凝露|精华|果酸|分装|旅行/.test(compact)) return { kind: "switch_goal", quote: text };
  if (/多少钱|价格|售价|贵不贵/.test(compact)) return { kind: "price_interruption", quote: text };
  if (/促销|优惠|活动|赠品|送什么|同价|差价|退换|退货|换货|授权|正品|真假/.test(compact)) return { kind: "policy_interruption", quote: text };
  if (pendingQuestion) return { kind: "answer_question", quote: text };
  if (/^(?:这款|这一款|这个|它)?(?:很)?(?:合适|可以|不错|挺好|正合适)(?:吧|呀|啊|的)?[。！!，,]*$|^(?:两款)?都(?:合适|可以|不错|挺好)[吧。！!]*$|^(?:就)?(?:要|选)(?:这款|这一款|这个|它)[吧。！!]*$/.test(compact)) return withMentions({ kind: "accept_current", quote: text });
  if (/^(?:这款|这一款|这个|它)?(?:不合适|不太合适|不行|不喜欢)(?:吧|呀|啊|的)?[。！!，,]*$/.test(compact)) return withMentions({ kind: "reject_current", quote: text });
  return { kind: "continue", quote: text };
}

export function classifySkuMentions(text: string): SkuMention[] {
  const compact = text.replace(/\s+/g, "");
  const skus = [...new Set((compact.match(/P[123]\d{2}/gi) ?? []).map((sku) => sku.toUpperCase()))].filter((sku) => Boolean(PRODUCTS_BY_SKU[sku]));
  if (!skus.length) return [];
  const comparing = /比|比较|区别|不同|和|跟|与|还是/.test(compact) && skus.length >= 2;
  return skus.map((sku): SkuMention => {
    const clause = compact.split(/[，,。；;！!？?]/).find((part) => part.includes(sku)) ?? compact;
    const escapedSku = sku.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const explicitRejection = new RegExp(`(?:不要|不选|排除|拒绝)${escapedSku}|${escapedSku}(?:不合适|不喜欢|太贵|不要|不选|排除)`);
    const explicitSelection = new RegExp(`(?:就要|要买|选择?|定|换成?|改成?|还是)${escapedSku}|${escapedSku}(?:就行|可以|合适|不错)`);
    let role: SkuMention["role"] = "target";
    if (comparing) role = "comparison";
    else if (explicitRejection.test(clause)) role = "rejection";
    else if (explicitSelection.test(clause)) role = "selection";
    else if (/为什么|怎么|多少钱|价格|售价|贵不贵|介绍|说说|了解|适合吗|推荐吗/.test(clause)) role = "inquiry";
    else if (!/(?:想买|想看|我要|要买|考虑|换成|改看|看看|选)/.test(compact)) role = "inquiry";
    return { sku, quote: sku, role };
  });
}

export function deterministicUnderstand(text: string, pendingQuestion?: StateField): TurnUnderstanding {
  const raw = text.trim();
  const compact = raw.replace(/\s+/g, "");
  const subject = subjectFor(compact);
  const historicalEmotion = /^(?:以前|曾经|过去).*(?:担心|烦|纠结|犹豫|开心)/.test(compact);
  const signals: TurnSignal[] = [];
  const lifestyle: LifestyleObservation[] = [];

  if (/担心|有点怕|怕.*(?:过敏|刺激|不适)|不放心/.test(compact)) signals.push(signal("emotion", "worried", raw, subject, true, historicalEmotion ? "historical" : "current"));
  if (/烦|选半天|挑半天|越看越乱|不想折腾/.test(compact)) signals.push(signal("emotion", "frustrated", raw, subject, true, historicalEmotion ? "historical" : "current"));
  if (/纠结|犹豫|拿不定|不知道选哪/.test(compact)) signals.push(signal("emotion", "hesitant", raw, subject, true, historicalEmotion ? "historical" : "current"));
  if (/太好了|正合适|很开心|就要这个/.test(compact)) signals.push(signal("emotion", "happy", raw, subject, true, historicalEmotion ? "historical" : "current"));
  if (/(?:网上|线上|淘宝|京东|拼多多).*(?:便宜|低)|为什么.*贵|差价/.test(compact)) signals.push(signal("communication", "price_objection", raw, subject));
  if (isExplicitRejection(compact)) signals.push(signal("communication", "reject", raw, subject));
  if ((/不想回答|不愿意回答|不方便说|不想说|别再问|别问了/.test(compact) || (pendingQuestion === "budget" && /还没想好|先看看|先看(?:看)?价格|暂时没想预算/.test(compact))) && !isExplicitRejection(compact)) signals.push(signal("communication", "decline_answer", raw, subject));
  if (/你理解错|不是这个意思|我说错了|改成|改为|其实是|算了.*还是/.test(compact)) signals.push(signal("communication", "correction", raw, subject));
  if (/赶时间|快一点|直接说|先说结论|别问太多/.test(compact)) signals.push(signal("communication", "hurry", raw, subject));
  if (/直接推荐|直接告诉我|给个结论/.test(compact)) signals.push(signal("communication", "direct_answer", raw, subject));
  if (/早上.*赶|早晨.*赶|赶着上班/.test(compact)) signals.push(signal("lifestyle", "morning_rush", raw, subject));
  if (/运动后|健身后|跑步后|游泳后/.test(compact)) signals.push(signal("lifestyle", "exercise", raw, subject));
  if (/出差|旅行|旅游/.test(compact)) signals.push(signal("lifestyle", "travel", raw, subject));
  if (/简单一点|精简护理|步骤少|不想多加步骤|不想折腾/.test(compact)) signals.push(signal("lifestyle", "simple_routine", raw, subject));
  if (/家里.*还(?:有|很多)|已经有|正在用|手头有/.test(compact)) signals.push(signal("lifestyle", "existing_routine", raw, subject));
  if (/洗后紧绷|洗完.*拔干|不喜欢黏|香味.*受不了/.test(compact)) signals.push(signal("lifestyle", "sensory_discomfort", raw, subject));

  const historical = /以前|曾经|过去/.test(compact);
  if (/简单一点|精简护理|步骤少|不想多加步骤/.test(compact)) lifestyle.push({ kind: "routine_preference", value: "simple", quote: raw, scope: historical ? "session" : "durable", explicit: true, subject });
  if (/(?:经常|常常|总是|每个月|每周).*(?:出差|旅行)|(?:出差|旅行).*(?:经常|常常|总是)/.test(compact)) lifestyle.push({ kind: "frequent_travel", value: true, quote: raw, scope: "durable", explicit: true, subject });
  if (/必须.*无香|不要香味|只要无香|只喜欢无香|不喜欢香味/.test(compact)) lifestyle.push({ kind: "fragrance_preference", value: "must_be_fragrance_free", quote: raw, scope: historical ? "session" : "durable", explicit: true, subject });
  else if (/对香味敏感|闻不了香|香味敏感/.test(compact)) lifestyle.push({ kind: "fragrance_preference", value: "fragrance_sensitive", quote: raw, scope: historical ? "session" : "durable", explicit: true, subject });
  else if (/喜欢香味|可以接受香味|能接受香味/.test(compact) && !/不喜欢|无香|不接受|讨厌|受不了/.test(compact)) lifestyle.push({ kind: "fragrance_preference", value: "accepts_fragrance", quote: raw, scope: historical ? "session" : "durable", explicit: true, subject });
  if (/不喜欢黏|讨厌黏|不要黏|(?<!不|没)喜欢轻薄|(?<!不|没)喜欢清爽/.test(compact)) lifestyle.push({ kind: "texture_preference", value: "lightweight", quote: raw, scope: historical ? "session" : "durable", explicit: true, subject });
  if (/不想重复买|避免重复买|已有.*不再买|只想买单品|以后.*单品/.test(compact)) lifestyle.push({ kind: "purchase_preference", value: /单品/.test(compact) ? "single_item" : "avoid_duplicate", quote: raw, scope: historical ? "session" : "durable", explicit: true, subject });

  const delta = deterministicExtract(text);
  if (pendingQuestion === "budget" && !delta.updates.some((item) => item.field === "budget")) {
    const budget = pendingBudgetAnswer(raw);
    if (budget !== undefined) delta.updates.push(update("budget", budget, raw));
  }
  if (pendingQuestion === "skinType" && !delta.updates.some((item) => item.field === "skinType")) {
    const answer = compact.replace(/[，。！？?!,.]/g, "");
    if (/^(?:我)?(?:是|偏|比较)?干(?:的|皮)?$/.test(answer)) delta.updates.push(update("skinType", "dry", raw));
    else if (/^(?:我)?(?:是|偏|比较)?油(?:的|皮)?$/.test(answer)) delta.updates.push(update("skinType", "oily", raw));
  }
  if ((pendingQuestion === "fragrancePreference" || pendingQuestion === "texturePreference") && !delta.updates.some((item) => item.field === pendingQuestion) && /^(?:我)?(?:都可以|无所谓|随便|都行)(?:吧|的)?[。！!，,]*$/.test(compact)) {
    delta.updates.push(update(pendingQuestion, "no_preference", raw));
  }
  if (pendingQuestion && !delta.updates.some((item) => item.field === pendingQuestion) && /^(?:我)?(?:觉得)?(?:还可以|还行|一般|差不多|说不好|说不清|不太确定|不确定|不清楚|不知道|没概念|分不清|看情况)(?:吧|的)?[。！!，,]*$/.test(compact)) {
    signals.push(signal("communication", "answer_ambiguous", raw, subject));
  }
  const skuMentions = classifySkuMentions(raw);
  return { delta, signals, lifestyle, purchaseAction: classifyPurchaseAction(raw, pendingQuestion), ...(skuMentions.length ? { skuMentions } : {}) };
}

export function validateDelta(delta: unknown, text: string): StateDelta | null {
  if (!delta || typeof delta !== "object" || !Array.isArray((delta as StateDelta).updates)) return null;
  const valid: StateDelta["updates"] = [];
  for (const candidate of (delta as StateDelta).updates) {
    if (!candidate || !fields.has(candidate.field) || typeof candidate.quote !== "string") continue;
    if (!candidate.quote || !text.includes(candidate.quote)) continue;
    if (!validFieldValue(candidate.field, candidate.value)) continue;
    const local = deterministicExtract(candidate.quote).updates.find((item) => item.field === candidate.field);
    // Every accepted field needs evidence in the quoted words, including
    // non-safety preferences. Unknown wording stays unconfirmed.
    const locallySupported = local && JSON.stringify(local.value) === JSON.stringify(candidate.value);
    const semanticFragrance = candidate.field === "fragrancePreference" && candidate.value === "accepts_fragrance" &&
      subjectFor(candidate.quote) === "self" && !/(?:以前|曾经|过去|之前|去年|上次|不喜欢|无香|不接受|讨厌|受不了)/.test(candidate.quote) &&
      /(?:香|味)/.test(candidate.quote) && /(?:喜欢|偏爱|好闻|能接受|可以接受)/.test(candidate.quote);
    // A low-risk preference may be semantically normalized from literal user
    // words. Safety facts still require the stricter local value agreement.
    const semanticNote = candidate.field === "fragranceNote" && typeof candidate.value === "string" &&
      candidate.value.length >= 2 && candidate.value.length <= 12 && candidate.quote.includes(candidate.value) &&
      subjectFor(candidate.quote) === "self" && !/(?:以前|曾经|过去|之前|去年|上次|不喜欢|无香|不接受|讨厌|受不了)/.test(candidate.quote) &&
      /(?:喜欢|偏爱|偏好|好闻)/.test(candidate.quote);
    const semanticTexture = candidate.field === "texturePreference" && candidate.value === "lightweight" &&
      subjectFor(candidate.quote) === "self" && !/(?:以前|曾经|过去|之前|去年|上次|不喜欢轻薄|不喜欢清爽)/.test(candidate.quote) &&
      /(?:喜欢|偏爱|偏好)(?:清爽|轻薄|不黏)|(?:讨厌|不喜欢)(?:黏|厚重)/.test(candidate.quote);
    if (!locallySupported && !semanticFragrance && !semanticNote && !semanticTexture) continue;
    valid.push({ ...candidate, extractedBy: "model", status: candidate.status === "unclear" ? "unclear" : "confirmed" });
  }
  return { updates: valid, extraction: "model", warnings: [] };
}

function validFieldValue(field: StateField, value: unknown): value is FactValue {
  const choices: Partial<Record<StateField, readonly string[]>> = {
    intent: ["recommend", "price", "policy", "clarify"],
    budgetScope: ["total", "current_item"],
    skinType: ["dry", "oily"],
    fragrancePreference: ["must_be_fragrance_free", "fragrance_sensitive", "accepts_fragrance", "no_preference"],
    coreConcern: ["roughness", "fresh_texture", "simple_routine"],
    texturePreference: ["lightweight", "avoid_tightness", "no_preference"],
    channelPreference: ["online", "offline"],
    giftBoxType: ["travel_kit", "skincare_gift_box"],
  };
  if (field === "budget" || field === "claimedOnlinePrice") return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
  if (["sensitiveTendency", "acidExperience", "travelNeed", "delegateChoice"].includes(field)) return typeof value === "boolean";
  if (field === "fragranceNote") return typeof value === "string" && value.length >= 2 && value.length <= 12;
  if (field === "currentDiscomfort" || symptomFields.includes(field as SymptomField)) return value === true || value === false || value === "unclear";
  if (field === "targetSku") return typeof value === "string" && Object.hasOwn(PRODUCTS_BY_SKU, value);
  if (["categories", "existingProducts", "useOccasions", "policyTopics"].includes(field)) {
    const allowed: Record<string, string[]> = {
      categories: ["cleanser", "moisturizer", "serum", "travel"],
      existingProducts: ["cleanser", "moisturizer", "serum"],
      useOccasions: ["morning_rush", "exercise", "travel"],
      policyTopics: ["promotion", "gift", "online_price", "return", "authorization"],
    };
    return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && allowed[field].includes(entry));
  }
  if (choices[field]) return typeof value === "string" && choices[field].includes(value);
  return false;
}

const signalKinds = new Set<SignalKind>(["emotion", "communication", "lifestyle"]);
const signalValues = new Set<SignalValue>(["worried", "frustrated", "hesitant", "happy", "price_objection", "reject", "correction", "hurry", "direct_answer", "answer_ambiguous", "decline_answer", "morning_rush", "exercise", "travel", "simple_routine", "existing_routine", "sensory_discomfort"]);
const habitKinds = new Set(["routine_preference", "frequent_travel", "fragrance_preference", "texture_preference", "purchase_preference"]);

export function validateUnderstanding(value: unknown, text: string, pendingQuestion?: StateField): TurnUnderstanding | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { updates?: unknown; signals?: unknown; lifestyle?: unknown; purchaseAction?: unknown; skuMentions?: unknown };
  const delta = validateDelta({ updates: raw.updates }, text);
  if (!delta) return null;
  const signals = Array.isArray(raw.signals) ? raw.signals.flatMap((item): TurnSignal[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<TurnSignal>;
    if (!candidate.kind || !signalKinds.has(candidate.kind) || !candidate.value || !signalValues.has(candidate.value) || typeof candidate.quote !== "string" || !candidate.quote || !text.includes(candidate.quote)) return [];
    if (candidate.value === "reject" && !isExplicitRejection(text.replace(/\s+/g, ""))) return [];
    if (candidate.value === "decline_answer" && !/不想回答|不愿意回答|不方便说|不想说|别再问|别问了|还没想好|先看看|先看(?:看)?价格|暂时没想预算/.test(text.replace(/\s+/g, ""))) return [];
    if (candidate.value === "answer_ambiguous" && (!pendingQuestion || delta.updates.some((update) => update.field === pendingQuestion))) return [];
    return [{ kind: candidate.kind, value: candidate.value, quote: candidate.quote, explicit: candidate.explicit !== false, subject: candidate.subject === "other" ? "other" : candidate.subject === "unknown" ? "unknown" : "self", temporal: candidate.temporal === "historical" ? "historical" : candidate.temporal === "unclear" ? "unclear" : "current" }];
  }) : [];
  const lifestyle = Array.isArray(raw.lifestyle) ? raw.lifestyle.flatMap((item): LifestyleObservation[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<LifestyleObservation>;
    if (!candidate.kind || !habitKinds.has(candidate.kind) || typeof candidate.quote !== "string" || !candidate.quote || !text.includes(candidate.quote) || !["string", "boolean"].includes(typeof candidate.value)) return [];
    if (candidate.value === "no_preference") return [];
    if (candidate.kind === "fragrance_preference" && candidate.value === "accepts_fragrance" && !/(?:喜欢香味|可以接受香味|能接受香味)/.test(candidate.quote)) return [];
    return [{ kind: candidate.kind, value: candidate.value as string | boolean, quote: candidate.quote, scope: candidate.scope === "durable" ? "durable" : candidate.scope === "session" ? "session" : "turn", explicit: candidate.explicit !== false, subject: candidate.subject === "other" ? "other" : candidate.subject === "unknown" ? "unknown" : "self" }];
  }) : [];
  let purchaseAction: PurchaseTurnAction | undefined;
  if (raw.purchaseAction && typeof raw.purchaseAction === "object") {
    const candidate = raw.purchaseAction as Partial<PurchaseTurnAction>;
    const kinds = new Set<PurchaseTurnAction["kind"]>(["answer_question", "switch_goal", "accept_current", "reject_current", "request_alternative", "ask_why_not", "compare_with_previous", "ask_about_product", "select_product", "price_interruption", "policy_interruption", "decline_answer", "end", "continue"]);
    if (candidate.kind && kinds.has(candidate.kind) && typeof candidate.quote === "string" && candidate.quote && text.includes(candidate.quote)) {
      const local = classifyPurchaseAction(candidate.quote, pendingQuestion);
      if (local.kind === candidate.kind) purchaseAction = local;
    }
  }
  const roles = new Set<SkuMention["role"]>(["target", "comparison", "inquiry", "rejection", "selection"]);
  const modelMentions = Array.isArray(raw.skuMentions) ? raw.skuMentions.flatMap((item): SkuMention[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<SkuMention>;
    if (typeof candidate.sku !== "string" || !PRODUCTS_BY_SKU[candidate.sku] || typeof candidate.quote !== "string" || !candidate.quote || !text.includes(candidate.quote) || !candidate.quote.toUpperCase().includes(candidate.sku) || !candidate.role || !roles.has(candidate.role)) return [];
    const compact = candidate.quote.replace(/\s+/g, "");
    const supported = candidate.role === "comparison" ? /比|比较|区别|不同|和|跟|与|还是/.test(text.replace(/\s+/g, ""))
      : candidate.role === "inquiry" ? /为什么|怎么|多少钱|价格|售价|贵不贵|介绍|说说|了解|适合吗|推荐吗/.test(text.replace(/\s+/g, ""))
        : candidate.role === "rejection" ? /不要|不选|不合适|不喜欢|太贵|排除/.test(compact)
          : candidate.role === "selection" ? /就要|选|选择|定下|还是/.test(compact)
            : /想买|想看|我要|考虑|换成|改看|看看/.test(compact) && !/为什么|多少钱|不合适|不要/.test(compact);
    return supported ? [{ sku: candidate.sku, quote: candidate.quote, role: candidate.role }] : [];
  }) : [];
  const skuMentions = modelMentions.length ? modelMentions : classifySkuMentions(text);
  return { delta, signals, lifestyle, purchaseAction, ...(skuMentions.length ? { skuMentions } : {}) };
}

export function mergeUnderstanding(primary: TurnUnderstanding | null, fallback: TurnUnderstanding): TurnUnderstanding {
  const delta = mergeDeltas(primary?.delta ?? null, fallback.delta);
  const mergeUnique = <T extends { kind: string; value: unknown }>(first: T[] = [], second: T[] = []) => {
    const byKey = new Map<string, T>();
    for (const item of [...first, ...second]) byKey.set(`${item.kind}:${String(item.value)}`, item);
    return [...byKey.values()];
  };
  return { delta, signals: mergeUnique(primary?.signals, fallback.signals), lifestyle: mergeUnique(primary?.lifestyle, fallback.lifestyle), purchaseAction: primary?.purchaseAction ?? fallback.purchaseAction, skuMentions: primary?.skuMentions ?? fallback.skuMentions };
}

export function mergeDeltas(primary: StateDelta | null, fallback: StateDelta): StateDelta {
  if (!primary) return fallback;
  const byField = new Map(primary.updates.map((item) => [item.field, item]));
  // A deterministic match is the locally verified interpretation of the user's
  // literal wording. The model may fill gaps, but it cannot overwrite that fact
  // with a stale value inferred from prior context.
  for (const item of fallback.updates) byField.set(item.field, item);
  return { updates: [...byField.values()], extraction: primary.extraction, warnings: primary.warnings };
}

export function applyDelta(state: UserState, delta: StateDelta): UserState {
  const turn = state.turn + 1;
  const facts = { ...state.facts };
  const history = [...state.history];
  const nextCategories = delta.updates.find((item) => item.field === "categories")?.value;
  if (Array.isArray(nextCategories) && facts.targetSku && !nextCategories.includes(PRODUCTS_BY_SKU[String(facts.targetSku.value)]?.category)) {
    history.push(facts.targetSku);
    delete facts.targetSku;
  }
  if (Array.isArray(nextCategories) && JSON.stringify(nextCategories) !== JSON.stringify(facts.categories?.value)) {
    if (facts.delegateChoice) history.push(facts.delegateChoice);
    delete facts.delegateChoice;
  }
  const nextFragrance = delta.updates.find((item) => item.field === "fragrancePreference")?.value;
  if (nextFragrance && nextFragrance !== "accepts_fragrance" && facts.fragranceNote) {
    history.push(facts.fragranceNote);
    delete facts.fragranceNote;
  }
  if (!delta.updates.some((item) => item.field === "policyTopics")) delete facts.policyTopics;
  if (!delta.updates.some((item) => item.field === "claimedOnlinePrice")) delete facts.claimedOnlinePrice;
  const explicitRecovery = delta.updates.some((item) => item.field === "currentDiscomfort" && item.value === false && /恢复|好了|没事|无不适|没有不适|稳定/.test(item.quote));
  let unresolvedLegacyDiscomfort = state.unresolvedLegacyDiscomfort ??
    (state.facts.currentDiscomfort?.value === true && !symptomFields.some((field) => state.facts[field]) ? true : false);
  if (explicitRecovery) unresolvedLegacyDiscomfort = false;
  for (const item of delta.updates) {
    if (item.field === "currentDiscomfort") continue; // The aggregate is derived, never model-owned.
    if (item.field === "targetSku" && Array.isArray(nextCategories) && !nextCategories.includes(PRODUCTS_BY_SKU[String(item.value)]?.category)) continue;
    const next: SourcedFact = { ...item, turn };
    const previous = facts[item.field];
    if (previous && JSON.stringify(previous.value) !== JSON.stringify(next.value)) history.push(previous);
    facts[item.field] = next;
  }
  const symptomFacts = symptomFields.map((field) => facts[field]).filter((item): item is SourcedFact => Boolean(item));
  const active = symptomFacts.filter((item) => item.value === true);
  const uncertain = symptomFacts.filter((item) => item.value === "unclear");
  const hadSpecificRisk = symptomFields.some((field) => state.facts[field]?.value === true || state.facts[field]?.value === "unclear");
  const derived = unresolvedLegacyDiscomfort || active.length ? true : uncertain.length ? "unclear" :
    explicitRecovery || (hadSpecificRisk && symptomFacts.length > 0 && symptomFacts.every((item) => item.value === false)) ||
    state.facts.currentDiscomfort?.value === false ? false : undefined;
  if (derived !== undefined) {
    const source = active.at(-1) ?? uncertain.at(-1) ??
      (unresolvedLegacyDiscomfort ? state.facts.currentDiscomfort : undefined) ??
      delta.updates.find((item) => item.field === "currentDiscomfort") ?? symptomFacts.at(-1);
    const sourceTurn = source && "turn" in source && typeof source.turn === "number" ? source.turn : turn;
    const next: SourcedFact = { field: "currentDiscomfort", value: derived, quote: source?.quote ?? state.facts.currentDiscomfort?.quote ?? "", turn: sourceTurn, status: derived === "unclear" ? "unclear" : "confirmed", extractedBy: source?.extractedBy ?? "local" };
    if (facts.currentDiscomfort && facts.currentDiscomfort.value !== derived) history.push(facts.currentDiscomfort);
    facts.currentDiscomfort = next;
  } else delete facts.currentDiscomfort;
  return { facts, history, turn, ...(unresolvedLegacyDiscomfort ? { unresolvedLegacyDiscomfort: true } : {}) };
}

export function fact<T extends FactValue>(state: UserState, field: StateField): T | undefined {
  return state.facts[field]?.value as T | undefined;
}

export function effectiveStateView(state: UserState) {
  return Object.fromEntries(Object.entries(state.facts).map(([key, item]) => [key, item ? { value: item.value, quote: item.quote, turn: item.turn, status: item.status } : null]));
}
