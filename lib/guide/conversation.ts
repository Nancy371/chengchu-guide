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
  categories: "这次最想先解决哪一件：洁面、保湿、精华，还是旅行分装？",
  budget: "如果要搭配着买，你希望总价大概控制在多少？我会按这个范围做取舍。",
  fragrancePreference: "香味这件事你在意吗？是可以接受，还是更想要无香的？",
  currentDiscomfort: "我先确认一下安全问题：现在还有刺痛、疼痛或破损吗？",
  sensitiveTendency: "你的皮肤平时容易敏感吗？现在如果有破损或不舒服，也一起告诉我。",
  acidExperience: "之前用过果酸或类似的焕肤产品吗？这个会影响我能不能继续推荐。",
  coreConcern: "真要做取舍时，你最想保住哪一点：清爽肤感、无香，还是价格？",
};

function questionFor(field: StateField, state: UserState) {
  if (field !== "skinType") return questionCopy[field] ?? "还差一条会影响选择的信息，你愿意时再告诉我就好。";
  const categories = fact<string[]>(state, "categories") ?? [];
  if (categories.includes("moisturizer")) return "平时皮肤更容易干，还是容易出油？这会影响我在滋润和清爽之间怎么选。";
  if (categories.includes("serum")) return "平时皮肤更偏干、偏油，还是容易敏感？这会影响这款精华能不能继续考虑。";
  return "平时洗完脸，你更常觉得紧绷，还是过一会儿容易出油？这个差别会直接影响洁面的选择。";
}

export const conversationLanguageRules = [
  "先回应用户这一轮明确说到的处境或感受，再推进购买问题；情绪不明确时只回应处境，不替用户贴标签。",
  "承接只用一句，落到用户原话里的具体处境，不说空泛的‘我理解你的心情’。",
  "追问要像当面聊天：一次只问一个购买决定，并顺手说明它为什么会影响选择。",
  "不用‘根据您的需求’‘请问您’‘为了更好地为您服务’‘亲’等客服或表单语言。",
  "不虚构自己的购物或护肤经历，不装熟，不使用催单、制造焦虑或过度热情的表达。",
  "保留事实的范围、条件和不确定性；自然表达不能改写价格、功效、安全边界或政策缺口。",
] as const;

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
  if (draft.action === "safety") return [{ id: "safety", text: "先别继续试新的或刺激性护理；如果疼痛、破损或不适一直没有缓解，建议尽快咨询专业人士。这一轮我先不推荐商品，也不作医疗诊断。" }];
  if (draft.action === "close") return [{ id: "close", text: "好，那这次就先停在这里。什么时候想再看看再来，不急。" }];
  if (draft.action === "policy_unknown") {
    const topics = fact<string[]>(state, "policyTopics") ?? [];
    const targetSku = draft.candidateSkus[0];
    const blocks: FactBlock[] = [];
    if (targetSku && PRODUCTS_BY_SKU[targetSku]) blocks.push({ id: `price:${targetSku}`, text: `手册中 ${targetSku} 的标价是 ${formatMoney(PRODUCTS_BY_SKU[targetSku].priceFen)}。` });
    blocks.push({ id: "policy-limit", text: `品牌手册里没有写明${topics.map((topic) => UNSUPPORTED_POLICY_TOPICS[topic] ?? topic).join("、")}，这点得请门店或系统确认，我不替他们猜。` });
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
      return [{ id: "budget-single", text: `你想把预算控制在 ${formatMoney(budget)} 左右。手册里的相关商品标价是 ${prices}，目前没有预算内的选择，不用为了买而硬加预算。` }];
    }
    return [{ id: "budget-bundle", text: `这套搭配合计 ${formatMoney(draft.totalFen ?? 0)}，比你的 ${formatMoney(budget)} 预算高 ${formatMoney(draft.budgetGapFen ?? 0)}，所以不能把它算成预算内方案。` }];
  }
  if (draft.action === "unavailable") return [{ id: "unavailable", text: `照你现在说的情况，现有商品里还没有适合直接推荐的。${draft.limitations.length ? `卡在这里：${draft.limitations.join("；")}。` : ""}` }];
  if (draft.action === "recommend") {
    if (draft.pricingMode === "alternatives") {
      return [{ id: "recommend-alternatives", text: `现在可以从 ${draft.recommendations.map((item) => `${item.sku} ${item.name}（${formatMoney(item.priceFen)}）`).join("和")} 里选一个。它们是两个备选，不用一起买。` }];
    }
    const names = draft.recommendations.map((item) => `${item.sku} ${item.name}`).join("＋");
    const amount = draft.totalFen ? `，合计 ${formatMoney(draft.totalFen)}` : "";
    const reason = draft.recommendations.flatMap((item) => item.reasons).slice(0, 2).join("；");
    const tradeoff = draft.recommendations.flatMap((item) => item.tradeoffs).slice(0, 2).join("；");
    return [
      { id: "recommendation", text: `按你现在说的情况，我会先看 ${names}${amount}。${reason ? `主要因为：${reason}。` : ""}` },
      ...(tradeoff ? [{ id: "tradeoff", text: `不过有一点要留意：${tradeoff}。` }] : []),
      { id: "no-pressure", text: "按你真正需要的买就好，不用为了凑一套多加东西。" },
    ];
  }
  return [];
}

function acknowledgementFor(policy: ConversationPolicy, signals: TurnSignal[]) {
  if (policy.userEmotion === "discomfort") return "听起来现在脸不太舒服。";
  if (policy.taskSkill === "conversation_repair" && policy.behaviorSkills.includes("routine_fit")) return "刚才是我听偏了。这次按你新说的方向来，也尽量少加步骤。";
  if (policy.taskSkill === "conversation_repair") return "刚才是我听偏了，按你新补充的情况重新看。";
  if (policy.taskSkill === "price_objection") return "差价摆在这儿，想问清楚很正常。";
  if (policy.userEmotion === "frustrated") return "看了半天还拿不定，确实挺耗神。我们先把范围收小。";
  if (policy.userEmotion === "worried") return "这个顾虑得先说清楚，免得买回去不合适。";
  if (policy.userEmotion === "hesitant") return "这几个放在一起确实不太好选，我帮你把差别压到最关键的一点。";
  if (policy.userEmotion === "happy") return "好，这下方向清楚多了。";
  if (policy.behaviorSkills.includes("routine_fit")) return "那就按简单省事来，不给你添步骤。";
  if (policy.behaviorSkills.includes("occasion_fit") && hasSignal(signals, "morning_rush")) return "早上时间紧，我们就挑关键的说。";
  if (policy.behaviorSkills.includes("existing_routine_respect")) return "手里的先用好，这次只补真正缺的。";
  if (policy.behaviorSkills.includes("gentle_recall") && policy.usedMemory) return "我会参考你之前保存的偏好；要是变了，直接纠正我就行。";
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
  const decisionContextChanged = (["categories", "targetSku"] as const).some((field) =>
    updatedFields.includes(field) && JSON.stringify(previousResult?.state?.facts?.[field]?.value) !== JSON.stringify(state.facts[field]?.value));
  const selectedQuestionFields = effectiveDraft.action === "clarify"
    ? effectiveDraft.questionFields.filter((field) => !repeated.has(field) || updatedFields.includes(field) || decisionContextChanged).slice(0, 1)
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
    factBlocks: [
      ...factsFor(effectiveDraft, state),
      ...(effectiveDraft.action === "clarify" && effectiveDraft.questionFields.includes("skinType") && !selectedQuestionFields.length
        ? [{ id: "skin-type-unconfirmed", text: "我还不能从这句话确认你偏干还是偏油，所以暂时不能按肤质选。你想清楚后直接告诉我就好。" }]
        : []),
    ],
    questionGoals: selectedQuestionFields.map((field) => ({ field, fallback: questionFor(field, state) })),
  };
}

function prohibitedFreeText(text: string) {
  return /P[123]\d{2}|[¥￥]|\d|保证|一定有效|治愈|治疗|绝对不过敏|马上见效|闭眼入|必须买|抓紧|最后机会|我也用|我买过|根据您的需求|请问您|为了更好地|很高兴为您|亲[，,]|我完全理解|(?:送|赠)(?:小样|礼品|赠品|东西)|赠品|退货|退款|换货|退换|拆封|包邮|正品|授权|淡斑|美白|抗老|祛痘|改善皱纹|手机号|电话|联系方式|地址|收货/.test(text);
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
  if (acknowledgement.length > 70 || closing.length > 70 || prohibitedFreeText(`${acknowledgement}${closing}`) || /[？?]/.test(`${acknowledgement}${closing}`)) return null;
  const questions = Array.isArray(proposal.questions) ? proposal.questions : [];
  if (questions.length !== plan.policy.selectedQuestionFields.length) return null;
  for (const question of questions) {
    if (!question || !plan.policy.selectedQuestionFields.includes(question.field) || typeof question.text !== "string" || !question.text.trim() || question.text.length > 90 || prohibitedFreeText(question.text)) return null;
    if ((question.text.match(/[？?]/g) ?? []).length !== 1) return null;
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
  const closing = plan.policy.nextAction === "clarify" && !questions.length ? "先不重复问了，你想起别的信息时再接着说就好。" : "";
  const parts = [acknowledgement, ...plan.factBlocks.map((block) => block.text), ...questions, closing].filter(Boolean);
  return { reply: parts.join(" "), questions, factBlockIds: plan.factBlocks.map((block) => block.id) };
}
