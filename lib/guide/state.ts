import type { FactValue, SourcedFact, StateDelta, StateField, UserState } from "./types";

export const EMPTY_STATE: UserState = { facts: {}, history: [], turn: 0 };

const fields = new Set<StateField>([
  "intent", "targetSku", "categories", "budget", "budgetScope", "skinType",
  "sensitiveTendency", "currentDiscomfort", "fragrancePreference", "acidExperience",
  "existingProducts", "travelNeed", "coreConcern", "channelPreference",
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
  if (/同价|补差价|网上.*便宜|线上.*便宜/.test(compact)) policyTopics.push("online_price");
  if (/退换|退货|换货/.test(compact)) policyTopics.push("return");
  if (/授权|正品|真假|假货/.test(compact)) policyTopics.push("authorization");
  if (policyTopics.length) updates.push(update("policyTopics", [...new Set(policyTopics)], raw));

  const priceQuestion = /多少钱|价格|售价|贵不贵/.test(compact);
  const wantsRecommendation = /想买|推荐|适合|考虑|要一套|只买|给我选/.test(compact) || categories.length > 0;
  updates.push(update("intent", policyTopics.length ? "policy" : priceQuestion ? "price" : wantsRecommendation ? "recommend" : "clarify", raw));

  const budgetCorrection = compact.match(/(?:预算)?(?:从[¥￥]?[1-9]\d{1,4})?(?:改成|改为|调整为|提高到|降到)[¥￥]?([1-9]\d{1,4})/);
  const budgetMatch = budgetCorrection ?? compact.match(/(?:预算|总预算|最多|到|不超过|控制在|可以到)(?:是|为)?[¥￥]?([1-9]\d{1,4})/);
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

  if (/必须.*无香|一点香味都没有|不要香味|只要无香/.test(compact)) updates.push(update("fragrancePreference", "must_be_fragrance_free", raw));
  else if (/对香味敏感|闻不了香|香味敏感/.test(compact)) updates.push(update("fragrancePreference", "fragrance_sensitive", raw));
  else if (/可以接受香味|能接受香味|喜欢香味|带香.*可以/.test(compact)) updates.push(update("fragrancePreference", "accepts_fragrance", raw));

  if (/没用过果酸|第一次用果酸|没有.*果酸.*经验/.test(compact)) updates.push(update("acidExperience", false, raw));
  else if (/用过果酸|果酸.*很多年|有.*焕肤.*经验|有.*果酸.*经验/.test(compact)) updates.push(update("acidExperience", true, raw));

  if (/保湿.*还有|已经有.*保湿|家里有.*保湿/.test(compact)) updates.push(update("existingProducts", ["moisturizer"], raw));
  if (/出差|旅行|旅游|随身携带|分装/.test(compact)) updates.push(update("travelNeed", true, raw));
  if (/粗糙/.test(compact)) updates.push(update("coreConcern", "roughness", raw));
  if (/清爽|轻薄/.test(compact)) updates.push(update("coreConcern", "fresh_texture", raw));
  if (/简单护理|精简护理/.test(compact)) updates.push(update("coreConcern", "simple_routine", raw));

  return { updates, extraction: "local", warnings: [] };
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

export function mergeDeltas(primary: StateDelta | null, fallback: StateDelta): StateDelta {
  if (!primary) return fallback;
  const byField = new Map(primary.updates.map((item) => [item.field, item]));
  for (const item of fallback.updates) if (!byField.has(item.field)) byField.set(item.field, item);
  return { updates: [...byField.values()], extraction: primary.extraction, warnings: primary.warnings };
}

export function applyDelta(state: UserState, delta: StateDelta): UserState {
  const turn = state.turn + 1;
  const facts = { ...state.facts };
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
