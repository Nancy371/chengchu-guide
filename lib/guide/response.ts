import { PRODUCTS_BY_SKU, UNSUPPORTED_POLICY_TOPICS } from "./catalog";
import { fact } from "./state";
import type { DecisionDraft, DecisionResult, ModelAudit, StateField, UserState } from "./types";

export function formatMoney(fen: number) {
  return `¥${(fen / 100).toFixed(fen % 100 ? 2 : 0)}`;
}

const questionCopy: Partial<Record<StateField, string>> = {
  categories: "您这次主要想看洁面、保湿、精华，还是旅行分装？",
  budget: "如果考虑组合，您的总预算大约是多少？",
  skinType: "您平时更偏干还是偏油？",
  fragrancePreference: "您能接受带香味的产品吗，还是更希望无香？",
  currentDiscomfort: "想确认一下：这种不舒服现在还在发生吗，有没有明显刺痛、疼痛或受损？",
  sensitiveTendency: "您的皮肤是否有敏感倾向，或目前有受损情况？",
  acidExperience: "您以前用过果酸或类似焕肤产品吗？目前皮肤状态稳定吗？",
  coreConcern: "如果需要取舍，您更在意清爽肤感、无香，还是控制预算？",
};

function policyReply(state: UserState) {
  const topics = fact<string[]>(state, "policyTopics") ?? [];
  const labels = topics.map((topic) => UNSUPPORTED_POLICY_TOPICS[topic] ?? topic);
  const targetSku = fact<string>(state, "targetSku");
  const price = targetSku && PRODUCTS_BY_SKU[targetSku] ? `手册中 ${targetSku} 的标价是 ${formatMoney(PRODUCTS_BY_SKU[targetSku].priceFen)}。` : "";
  return `${price}${labels.join("、")}在品牌手册中没有说明，需要向门店或系统确认，我不替门店作承诺。`;
}

export function composeResult(draft: DecisionDraft, state: UserState, audits: ModelAudit[], versions: DecisionResult["versions"]): DecisionResult {
  const questions = draft.questionFields.map((field) => questionCopy[field]).filter((item): item is string => Boolean(item));
  let reply = "我还需要确认一点信息，才能给您更合适的建议。";
  if (draft.action === "safety") reply = "听起来您现在可能有明显不适。先暂停新的或刺激性护理尝试；如果疼痛、受损或不适持续，建议尽快咨询专业人士。我这边先不继续推荐商品，也不作医疗诊断。";
  if (draft.action === "policy_unknown") reply = policyReply(state);
  if (draft.action === "price_answer") {
    const item = draft.recommendations[0];
    reply = `${item.sku}（${item.name} · ${PRODUCTS_BY_SKU[item.sku].size}）手册标价是 ${formatMoney(item.priceFen)}。${item.sku === "P102" ? "源文件中的完整名称有缺字，所以我没有自行补全。" : ""}`;
  }
  if (draft.action === "clarify" && questions.length) reply = questions.join(" ");
  if (draft.action === "unavailable") reply = `按目前已确认的信息，我不建议直接推荐现有候选。${draft.limitations.length ? `主要原因是：${draft.limitations.join("；")}。` : ""}`;
  if (draft.action === "budget_conflict") {
    const budget = fact<number>(state, "budget") ?? 0;
    reply = `这套组合合计 ${formatMoney(draft.totalFen ?? 0)}，比您目前的 ${formatMoney(budget)} 预算高 ${formatMoney(draft.budgetGapFen ?? 0)}。我不会把它说成预算内方案；如果需要取舍，您想先从洁面还是保湿开始？`;
  }
  if (draft.action === "recommend") {
    const names = draft.recommendations.map((item) => `${item.sku} ${item.name}`).join("＋");
    const amount = draft.totalFen ? `，合计 ${formatMoney(draft.totalFen)}` : "";
    const reason = draft.recommendations.flatMap((item) => item.reasons).slice(0, 2).join("；");
    const tradeoff = draft.recommendations.flatMap((item) => item.tradeoffs).slice(0, 2).join("；");
    reply = `可以考虑 ${names}${amount}。${reason ? `理由是：${reason}。` : ""}${tradeoff ? `需要留意：${tradeoff}。` : ""}您可以按自己的偏好决定，不需要为了凑套装增加购买。`;
  }
  return { ...draft, reply, questions, state, audits, versions };
}
