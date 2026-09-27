import type { FactValue, LifestyleObservation, SignalKind, SignalValue, SourcedFact, StateDelta, StateField, TurnSignal, TurnUnderstanding, UserState } from "./types";

export const EMPTY_STATE: UserState = { facts: {}, history: [], turn: 0 };

const fields = new Set<StateField>([
  "intent", "targetSku", "categories", "budget", "budgetScope", "skinType",
  "sensitiveTendency", "currentDiscomfort", "fragrancePreference", "acidExperience",
  "existingProducts", "travelNeed", "useOccasions", "texturePreference", "coreConcern", "channelPreference",
  "claimedOnlinePrice", "policyTopics",
]);

function update(field: StateField, value: FactValue, text: string, status: "confirmed" | "unclear" = "confirmed") {
  return { field, value, quote: text, status, extractedBy: "local" as const };
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
  if (categories.length) updates.push(update("categories", [...new Set(categories)], raw));

  const sku = compact.match(/P[123]\d{2}/i)?.[0]?.toUpperCase();
  if (sku) updates.push(update("targetSku", sku, raw));

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

  if (/偏干|干皮|干燥/.test(compact)) updates.push(update("skinType", "dry", raw));
  if (/偏油|油皮|容易出油/.test(compact)) updates.push(update("skinType", "oily", raw));

  if (/没有敏感|不敏感/.test(compact)) updates.push(update("sensitiveTendency", false, raw));
  else if (/敏感肌|容易敏感|敏感倾向|皮肤敏感/.test(compact)) updates.push(update("sensitiveTendency", true, raw));

  if (/没有不适|无不适|现在没事|目前稳定|状态稳定|没有刺痛|不疼/.test(compact)) {
    updates.push(update("currentDiscomfort", false, raw));
  } else if (/很疼|脸疼|刺痛|灼痛|红肿|破损|受损|持续不适|还在疼|现在.*不舒服/.test(compact)) {
    updates.push(update("currentDiscomfort", true, raw));
  } else if (/有点不舒服|不太舒服|好像不舒服/.test(compact)) {
    updates.push(update("currentDiscomfort", "unclear", raw, "unclear"));
  }

  if (/必须.*无香|一点香味都没有|不要香味|只要无香|只喜欢无香/.test(compact)) updates.push(update("fragrancePreference", "must_be_fragrance_free", raw));
  else if (/对香味敏感|闻不了香|香味敏感/.test(compact)) updates.push(update("fragrancePreference", "fragrance_sensitive", raw));
  else if (/可以接受香味|能接受香味|喜欢香味|带香.*可以/.test(compact)) updates.push(update("fragrancePreference", "accepts_fragrance", raw));

  if (/没用过果酸|第一次用果酸|没有.*果酸.*经验/.test(compact)) updates.push(update("acidExperience", false, raw));
  else if (/用过果酸|果酸.*很多年|有.*焕肤.*经验|有.*果酸.*经验/.test(compact)) updates.push(update("acidExperience", true, raw));

  if (/保湿.*还(?:有|很多)|已经有.*保湿|家里有.*保湿/.test(compact)) updates.push(update("existingProducts", ["moisturizer"], raw));
  if (/出差|旅行|旅游|随身携带|分装/.test(compact)) updates.push(update("travelNeed", true, raw));
  const occasions: string[] = [];
  if (/早上.*赶|早晨.*赶|晨间.*赶|赶着上班/.test(compact)) occasions.push("morning_rush");
  if (/运动后|健身后|跑步后|游泳后/.test(compact)) occasions.push("exercise");
  if (/出差|旅行|旅游/.test(compact)) occasions.push("travel");
  if (occasions.length) updates.push(update("useOccasions", occasions, raw));
  if (/不喜欢黏|讨厌黏|不要黏|喜欢轻薄|喜欢清爽/.test(compact)) updates.push(update("texturePreference", "lightweight", raw));
  if (/洗后紧绷|洗完.*紧绷|洗完.*拔干/.test(compact)) updates.push(update("texturePreference", "avoid_tightness", raw));
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

export function deterministicUnderstand(text: string): TurnUnderstanding {
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
  else if (/喜欢香味|可以接受香味|能接受香味/.test(compact)) lifestyle.push({ kind: "fragrance_preference", value: "accepts_fragrance", quote: raw, scope: historical ? "session" : "durable", explicit: true, subject });
  if (/不喜欢黏|讨厌黏|不要黏|喜欢轻薄|喜欢清爽/.test(compact)) lifestyle.push({ kind: "texture_preference", value: "lightweight", quote: raw, scope: historical ? "session" : "durable", explicit: true, subject });
  if (/不想重复买|避免重复买|已有.*不再买|只想买单品|以后.*单品/.test(compact)) lifestyle.push({ kind: "purchase_preference", value: /单品/.test(compact) ? "single_item" : "avoid_duplicate", quote: raw, scope: historical ? "session" : "durable", explicit: true, subject });

  return { delta: deterministicExtract(text), signals, lifestyle };
}

export function validateDelta(delta: unknown, text: string): StateDelta | null {
  if (!delta || typeof delta !== "object" || !Array.isArray((delta as StateDelta).updates)) return null;
  const valid: StateDelta["updates"] = [];
  for (const candidate of (delta as StateDelta).updates) {
    if (!candidate || !fields.has(candidate.field) || typeof candidate.quote !== "string") continue;
    if (!candidate.quote || !text.includes(candidate.quote)) continue;
    if (!["string", "number", "boolean", "object"].includes(typeof candidate.value)) continue;
    valid.push({ ...candidate, extractedBy: "model", status: candidate.status === "unclear" ? "unclear" : "confirmed" });
  }
  return { updates: valid, extraction: "model", warnings: [] };
}

const signalKinds = new Set<SignalKind>(["emotion", "communication", "lifestyle"]);
const signalValues = new Set<SignalValue>(["worried", "frustrated", "hesitant", "happy", "price_objection", "reject", "correction", "hurry", "direct_answer", "morning_rush", "exercise", "travel", "simple_routine", "existing_routine", "sensory_discomfort"]);
const habitKinds = new Set(["routine_preference", "frequent_travel", "fragrance_preference", "texture_preference", "purchase_preference"]);

export function validateUnderstanding(value: unknown, text: string): TurnUnderstanding | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { updates?: unknown; signals?: unknown; lifestyle?: unknown };
  const delta = validateDelta({ updates: raw.updates }, text);
  if (!delta) return null;
  const signals = Array.isArray(raw.signals) ? raw.signals.flatMap((item): TurnSignal[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<TurnSignal>;
    if (!candidate.kind || !signalKinds.has(candidate.kind) || !candidate.value || !signalValues.has(candidate.value) || typeof candidate.quote !== "string" || !candidate.quote || !text.includes(candidate.quote)) return [];
    if (candidate.value === "reject" && !isExplicitRejection(text.replace(/\s+/g, ""))) return [];
    return [{ kind: candidate.kind, value: candidate.value, quote: candidate.quote, explicit: candidate.explicit !== false, subject: candidate.subject === "other" ? "other" : candidate.subject === "unknown" ? "unknown" : "self", temporal: candidate.temporal === "historical" ? "historical" : candidate.temporal === "unclear" ? "unclear" : "current" }];
  }) : [];
  const lifestyle = Array.isArray(raw.lifestyle) ? raw.lifestyle.flatMap((item): LifestyleObservation[] => {
    if (!item || typeof item !== "object") return [];
    const candidate = item as Partial<LifestyleObservation>;
    if (!candidate.kind || !habitKinds.has(candidate.kind) || typeof candidate.quote !== "string" || !candidate.quote || !text.includes(candidate.quote) || !["string", "boolean"].includes(typeof candidate.value)) return [];
    return [{ kind: candidate.kind, value: candidate.value as string | boolean, quote: candidate.quote, scope: candidate.scope === "durable" ? "durable" : candidate.scope === "session" ? "session" : "turn", explicit: candidate.explicit !== false, subject: candidate.subject === "other" ? "other" : candidate.subject === "unknown" ? "unknown" : "self" }];
  }) : [];
  return { delta, signals, lifestyle };
}

export function mergeUnderstanding(primary: TurnUnderstanding | null, fallback: TurnUnderstanding): TurnUnderstanding {
  const delta = mergeDeltas(primary?.delta ?? null, fallback.delta);
  const mergeUnique = <T extends { kind: string; value: unknown }>(first: T[] = [], second: T[] = []) => {
    const byKey = new Map<string, T>();
    for (const item of [...first, ...second]) byKey.set(`${item.kind}:${String(item.value)}`, item);
    return [...byKey.values()];
  };
  return { delta, signals: mergeUnique(primary?.signals, fallback.signals), lifestyle: mergeUnique(primary?.lifestyle, fallback.lifestyle) };
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
  if (!delta.updates.some((item) => item.field === "policyTopics")) delete facts.policyTopics;
  if (!delta.updates.some((item) => item.field === "claimedOnlinePrice")) delete facts.claimedOnlinePrice;
  const history = [...state.history];
  for (const item of delta.updates) {
    const next: SourcedFact = { ...item, turn };
    const previous = facts[item.field];
    if (previous && JSON.stringify(previous.value) !== JSON.stringify(next.value)) history.push(previous);
    facts[item.field] = next;
  }
  return { facts, history, turn };
}

export function fact<T extends FactValue>(state: UserState, field: StateField): T | undefined {
  return state.facts[field]?.value as T | undefined;
}

export function effectiveStateView(state: UserState) {
  return Object.fromEntries(Object.entries(state.facts).map(([key, item]) => [key, item ? { value: item.value, quote: item.quote, turn: item.turn, status: item.status } : null]));
}
