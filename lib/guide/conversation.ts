import { PRODUCTS_BY_SKU, UNSUPPORTED_POLICY_TOPICS } from "./catalog";
import { fact } from "./state";
import type {
  ConversationAct,
  ConversationBehaviorSkill,
  ConversationPolicy,
  DecisionDraft,
  DecisionResult,
  HabitMemory,
  LifestyleObservation,
  StateField,
  TurnSignal,
  UserState,
} from "./types";

export interface FactBlock {
  id: string;
  text: string;
}

export interface ConversationPlan {
  policy: ConversationPolicy;
  factBlocks: FactBlock[];
  questionGoals: Array<{ field: StateField; fallback: string }>;
}

export interface RenderProposal {
  acknowledgement?: string;
  blockIds?: string[];
  questions?: Array<{ field: StateField; text: string }>;
  closing?: string;
  actsUsed?: ConversationAct[];
}

export interface RenderedCopy {
  reply: string;
  questions: string[];
  factBlockIds: string[];
}

const questionCopy: Partial<Record<StateField, string>> = {
  categories: "这次主要想看洁面、保湿、精华，还是旅行分装？",
  budget: "如果考虑组合，总预算大约想控制在多少？",
  skinType: "你洗完脸更容易觉得紧绷，还是比较容易出油？这个会直接影响洁面的选择。",
  fragrancePreference: "你能接受带香味的产品，还是更希望无香？",
  currentDiscomfort: "这种不舒服现在还在发生吗，有没有明显刺痛、疼痛或受损？",
  sensitiveTendency: "皮肤平时有敏感倾向，或者目前有受损情况吗？",
  acidExperience: "以前用过果酸或类似焕肤产品吗？",
  coreConcern: "如果需要取舍，你更在意清爽肤感、无香，还是控制预算？",
};

export function formatMoney(fen: number) {
  return `¥${(fen / 100).toFixed(fen % 100 ? 2 : 0)}`;
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
  if (hasSignal(signals, "hesitant") || draft.recommendations.length > 1 || draft.action === "unavailable" || draft.action === "close") return "decision_support";
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

function factsFor(draft: DecisionDraft, state: UserState): FactBlock[] {
  if (draft.action === "safety") return [{ id: "safety", text: "先暂停新的或刺激性护理尝试；如果疼痛、受损或不适持续，建议尽快咨询专业人士。我这里先不继续推荐商品，也不作医疗诊断。" }];
  if (draft.action === "close") return [{ id: "close", text: "好，那这次先不继续推荐，也不用急着做决定。" }];
  if (draft.action === "policy_unknown") {
    const topics = fact<string[]>(state, "policyTopics") ?? [];
    const targetSku = fact<string>(state, "targetSku");
    const blocks: FactBlock[] = [];
    if (targetSku && PRODUCTS_BY_SKU[targetSku]) blocks.push({ id: `price:${targetSku}`, text: `手册中 ${targetSku} 的标价是 ${formatMoney(PRODUCTS_BY_SKU[targetSku].priceFen)}。` });
    blocks.push({ id: "policy-limit", text: `${topics.map((topic) => UNSUPPORTED_POLICY_TOPICS[topic] ?? topic).join("、")}在品牌手册中没有说明，需要向门店或系统确认，我不会替门店作承诺。` });
    return blocks;
  }
  if (draft.action === "price_answer") {
    const item = draft.recommendations[0];
    if (!item) return [];
    return [{ id: `price:${item.sku}`, text: `${item.sku}（${item.name} · ${PRODUCTS_BY_SKU[item.sku].size}）手册标价是 ${formatMoney(item.priceFen)}。${item.sku === "P102" ? "源文件中的完整名称有缺字，所以没有自行补全。" : ""}` }];
  }
  if (draft.action === "budget_conflict") {
    const budget = fact<number>(state, "budget") ?? 0;
    if (draft.pricingMode === "single" && !draft.recommendations.length) {
      const prices = draft.evidence.filter((item) => item.id.startsWith("price:")).map((item) => `${item.label.replace(" 手册标价", "")} ${item.detail}`).join("、");
      return [{ id: "budget-single", text: `你想把预算控制在 ${formatMoney(budget)} 左右。手册里的相关商品标价是 ${prices}，目前没有预算内候选，先不用为了买而提高预算。` }];
    }
    return [{ id: "budget-bundle", text: `这套组合合计 ${formatMoney(draft.totalFen ?? 0)}，比目前的 ${formatMoney(budget)} 预算高 ${formatMoney(draft.budgetGapFen ?? 0)}，不能算作预算内方案。` }];
  }
  if (draft.action === "unavailable") return [{ id: "unavailable", text: `按目前确认的信息，不建议直接推荐现有候选。${draft.limitations.length ? `主要原因是：${draft.limitations.join("；")}。` : ""}` }];
  if (draft.action === "recommend") {
    if (draft.pricingMode === "alternatives") {
      return [{ id: "recommend-alternatives", text: `目前可以比较 ${draft.recommendations.map((item) => `${item.sku} ${item.name}（${formatMoney(item.priceFen)}）`).join("和")}。它们是备选项，不是需要一起购买的组合。` }];
    }
    const names = draft.recommendations.map((item) => `${item.sku} ${item.name}`).join("＋");
    const amount = draft.totalFen ? `，合计 ${formatMoney(draft.totalFen)}` : "";
    const reason = draft.recommendations.flatMap((item) => item.reasons).slice(0, 2).join("；");
    const tradeoff = draft.recommendations.flatMap((item) => item.tradeoffs).slice(0, 2).join("；");
    return [
      { id: "recommendation", text: `可以考虑 ${names}${amount}。${reason ? `理由是：${reason}。` : ""}` },
      ...(tradeoff ? [{ id: "tradeoff", text: `需要留意：${tradeoff}。` }] : []),
      { id: "no-pressure", text: "可以按自己的偏好决定，不需要为了凑套装增加购买。" },
    ];
  }
  return [];
}

function acknowledgementFor(policy: ConversationPolicy, signals: TurnSignal[]) {
  if (policy.taskSkill === "conversation_repair") return "是我前面理解偏了，按你刚补充的信息重新看。";
  if (policy.taskSkill === "price_objection") return "有差价的话，认真比较很合理。";
  if (policy.userEmotion === "frustrated") return "选来选去确实容易累，我们把选择收窄一点。";
  if (policy.userEmotion === "worried") return "有这个顾虑很正常，我们先把会影响安全和选择的部分确认清楚。";
  if (policy.userEmotion === "hesitant") return "几个选择放在一起时，确实容易拿不准。";
  if (policy.userEmotion === "happy") return "好，那方向就清楚了。";
  if (policy.behaviorSkills.includes("routine_fit")) return "那就按省步骤来选。";
  if (policy.behaviorSkills.includes("occasion_fit") && hasSignal(signals, "morning_rush")) return "早上赶时间的话，我们尽量说得直接一点。";
  if (policy.behaviorSkills.includes("existing_routine_respect")) return "已有的先用好就行，这次只补真正缺的。";
  if (policy.behaviorSkills.includes("gentle_recall") && policy.usedMemory) return "这次也会把你之前保存的偏好算进去；如果变了，直接告诉我就好。";
  return "";
}

export function planConversation(input: {
  draft: DecisionDraft;
  state: UserState;
  signals: TurnSignal[];
  lifestyle: LifestyleObservation[];
  memories: HabitMemory[];
  previousResult?: DecisionResult | null;
  updatedFields: StateField[];
}): ConversationPlan {
  const { draft, state, signals, lifestyle, memories, previousResult, updatedFields } = input;
  const memory = relevantMemory(state, memories, draft);
  const rejected = hasSignal(signals, "reject");
  const effectiveDraft: DecisionDraft = rejected && draft.action !== "safety" ? { ...draft, action: "close", recommendations: [], candidateSkus: [], totalFen: undefined, budgetGapFen: undefined, routeReason: "用户明确表示停止推荐或暂不购买" } : draft;
  const repeated = new Set(previousResult?.questionFields ?? []);
  const selectedQuestionFields = effectiveDraft.action === "clarify"
    ? effectiveDraft.questionFields.filter((field) => !repeated.has(field) || updatedFields.includes(field)).slice(0, 1)
    : [];
  const emotion = acknowledgedEmotion(signals, effectiveDraft);
  const behaviorSkills = selectBehaviorSkills(signals, lifestyle, memory, effectiveDraft.action);
  const task = taskSkill(effectiveDraft, signals, state);
  const shouldAcknowledge = task === "conversation_repair" || task === "price_objection" || emotion !== "neutral" || behaviorSkills.some((item) => ["routine_fit", "existing_routine_respect", "occasion_fit", "gentle_recall"].includes(item));
  const acts: ConversationAct[] = [
    ...(shouldAcknowledge ? ["acknowledge" as const] : []),
    ...(effectiveDraft.action === "budget_conflict" || effectiveDraft.action === "close" ? ["reduce_pressure" as const] : []),
    ...(effectiveDraft.action === "policy_unknown" || effectiveDraft.action === "unavailable" ? ["state_limit" as const] : ["state_fact" as const]),
    ...(selectedQuestionFields.length ? ["explain_reason" as const, "ask_question" as const] : []),
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
    shouldExplainReason: selectedQuestionFields.length > 0,
    emojiPolicy: !calm && state.turn <= 1 && ["clarify", "recommend"].includes(effectiveDraft.action) ? "optional_one" : "none",
    acknowledgedSignal: firstEmotion(signals) ?? signals.find((item) => item.explicit && item.subject !== "other" && item.temporal !== "historical" && ["price_objection", "correction", "hurry", "simple_routine", "existing_routine"].includes(item.value)),
    usedMemory: memory ? { id: memory.id, kind: memory.kind, value: memory.value } : undefined,
  };
  return {
    policy,
    factBlocks: factsFor(effectiveDraft, state),
    questionGoals: selectedQuestionFields.map((field) => ({ field, fallback: questionCopy[field] ?? "可以再补充一点会影响选择的信息吗？" })),
  };
}

function prohibitedFreeText(text: string) {
  return /P[123]\d{2}|[¥￥]|\d|保证|一定有效|治愈|治疗|绝对不过敏|马上见效|闭眼入|必须买|抓紧|最后机会|我也用|我买过/.test(text);
}

function emojiCount(text: string) {
  return (text.match(/[\p{Extended_Pictographic}]/gu) ?? []).length;
}

export function validateRenderProposal(value: unknown, plan: ConversationPlan): RenderedCopy | null {
  if (!value || typeof value !== "object") return null;
  const proposal = value as RenderProposal;
  const requiredIds = plan.factBlocks.map((block) => block.id);
  if (!Array.isArray(proposal.blockIds) || proposal.blockIds.length !== requiredIds.length || new Set(proposal.blockIds).size !== requiredIds.length || proposal.blockIds.some((id) => !requiredIds.includes(id))) return null;
  const acknowledgement = typeof proposal.acknowledgement === "string" ? proposal.acknowledgement.trim() : "";
  const closing = typeof proposal.closing === "string" ? proposal.closing.trim() : "";
  if (plan.policy.shouldAcknowledge && !acknowledgement) return null;
  if (acknowledgement.length > 70 || closing.length > 70 || prohibitedFreeText(`${acknowledgement}${closing}`)) return null;
  const questions = Array.isArray(proposal.questions) ? proposal.questions : [];
  if (questions.length !== plan.policy.selectedQuestionFields.length) return null;
  for (const question of questions) {
    if (!question || !plan.policy.selectedQuestionFields.includes(question.field) || typeof question.text !== "string" || !question.text.trim() || question.text.length > 90 || prohibitedFreeText(question.text)) return null;
  }
  const freeText = [acknowledgement, ...questions.map((item) => item.text), closing].join("");
  if (plan.policy.emojiPolicy === "none" && emojiCount(freeText) > 0) return null;
  if (plan.policy.emojiPolicy === "optional_one" && emojiCount(freeText) > 1) return null;
  const blockMap = new Map(plan.factBlocks.map((block) => [block.id, block.text]));
  const parts = [acknowledgement, ...proposal.blockIds.map((id) => blockMap.get(id) ?? ""), ...questions.map((item) => item.text.trim()), closing].filter(Boolean);
  const reply = parts.join(" ");
  if (!reply || reply.length > 420) return null;
  return { reply, questions: questions.map((item) => item.text.trim()), factBlockIds: proposal.blockIds };
}

export function renderTemplate(plan: ConversationPlan, signals: TurnSignal[]): RenderedCopy {
  const acknowledgement = plan.policy.shouldAcknowledge ? acknowledgementFor(plan.policy, signals) : "";
  const questions = plan.questionGoals.map((item) => item.fallback);
  const closing = plan.policy.nextAction === "clarify" && !questions.length ? "你愿意时再补充就好，我先不重复追问。" : "";
  const parts = [acknowledgement, ...plan.factBlocks.map((block) => block.text), ...questions, closing].filter(Boolean);
  return { reply: parts.join(" "), questions, factBlockIds: plan.factBlocks.map((block) => block.id) };
}
