import { readFile, writeFile } from "node:fs/promises";
import { planConversation, renderTemplate } from "../lib/guide/conversation";
import { decide } from "../lib/guide/decision";
import { applyDelta, deterministicUnderstand } from "../lib/guide/state";
import type { DecisionResult, UserState } from "../lib/guide/types";

type EvalCase = { id: string; group: string; turns: string[] };
type Pair = { id: string; user: string; A: string; B: string; currentLabel: "A" | "B" };

const key = process.env.DEEPSEEK_API_KEY;
if (!key) throw new Error("DEEPSEEK_API_KEY is required for the frozen model quality evaluation");

const cases = JSON.parse(await readFile(new URL("../evals/conversation-cases.json", import.meta.url), "utf8")) as EvalCase[];

function legacyReply(result: DecisionResult) {
  if (result.action === "clarify") return "请补充以下信息：" + result.questions.join(" ");
  if (result.action === "safety") return "检测到不适信息，建议暂停使用并咨询专业人士。";
  if (result.action === "budget_conflict") return "根据您的预算，当前商品不符合要求。";
  if (result.action === "policy_unknown") return "相关政策暂无资料，建议咨询门店。";
  if (result.recommendations.length) return "根据您的需求，推荐：" + result.recommendations.map((item) => item.name).join("、") + "。";
  return result.reply;
}

const pairs: Pair[] = [];
for (const item of cases) {
  let state: UserState = { facts: {}, history: [], turn: 0 };
  let result: DecisionResult | null = null;
  for (const text of item.turns) {
    const understanding = deterministicUnderstand(text);
    state = applyDelta(state, understanding.delta);
    const draft = decide(state);
    const plan = planConversation({ draft, state, signals: understanding.signals, lifestyle: understanding.lifestyle, memories: [], previousResult: result, updatedFields: understanding.delta.updates.map((entry) => entry.field) });
    const copy = renderTemplate(plan, understanding.signals);
    result = { ...draft, action: plan.policy.nextAction, questionFields: plan.policy.selectedQuestionFields, recommendations: plan.policy.nextAction === "close" ? [] : draft.recommendations, reply: copy.reply, questions: copy.questions, state, audits: [], turnSignals: understanding.signals, lifestyle: understanding.lifestyle, conversationPolicy: plan.policy, render: { source: "template", validationPassed: true, factBlockIds: copy.factBlockIds }, versions: { input: state.turn, state: state.turn, knowledge: "eval" } };
  }
  if (!result) continue;
  const currentLabel = Number(item.id.replace(/\D/g, "")) % 2 ? "A" : "B";
  const current = result.reply;
  const old = legacyReply(result);
  pairs.push({ id: item.id, user: item.turns.at(-1) ?? "", A: currentLabel === "A" ? current : old, B: currentLabel === "B" ? current : old, currentLabel });
}

const rubric = {
  version: "chengchu-conversation-quality-v1",
  model: "deepseek-flash",
  temperature: 0,
  dimensions: ["acknowledgement", "lifestyle_relevance", "naturalness", "conciseness", "low_pressure"],
  scoreRange: [1, 5],
  robotLikeRange: [1, 5],
};

const rows: unknown[] = [];
for (let index = 0; index < pairs.length; index += 10) {
  const batch = pairs.slice(index, index + 10);
  const response = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: rubric.model,
      temperature: rubric.temperature,
      max_tokens: 2600,
      response_format: { type: "json_object" },
      thinking: { type: "disabled" },
      messages: [
        { role: "system", content: "你是盲评员。逐条比较 A/B 导购回复，不猜版本。按承接准确性、生活场景相关性、自然度、简洁度、无压力感分别给 1-5 分，并给机器人感 1-5 分（越高越像机器人）。事实或安全违规写入 violations。只输出 JSON：{rows:[{id,A:{acknowledgement,lifestyle_relevance,naturalness,conciseness,low_pressure,robot_like,violations:[]},B:{...},preferred:'A'|'B'|'tie'}]}。" },
        { role: "user", content: JSON.stringify({ rubric, cases: batch.map((entry) => ({ id: entry.id, user: entry.user, A: entry.A, B: entry.B })) }) },
      ],
    }),
  });
  if (!response.ok) throw new Error(`judge_http_${response.status}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const parsed = JSON.parse(payload.choices?.[0]?.message?.content ?? "{}") as { rows?: unknown[] };
  rows.push(...(parsed.rows ?? []));
}

const output = { rubric, blindPairs: pairs.map(({ currentLabel, ...pair }) => ({ ...pair, currentLabelAfterJudging: currentLabel })), rows, generatedAt: new Date().toISOString() };
const target = new URL("../evals/latest-model-judge.json", import.meta.url);
await writeFile(target, JSON.stringify(output, null, 2) + "\n");
console.log(`Saved ${rows.length} blind judgments to ${target.pathname}`);
