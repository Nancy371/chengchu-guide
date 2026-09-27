import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { planConversation, renderTemplate } from "../lib/guide/conversation";
import { decide } from "../lib/guide/decision";
import { applyDelta, deterministicUnderstand, mergeUnderstanding } from "../lib/guide/state";
import type { DecisionResult, TurnUnderstanding, UserState } from "../lib/guide/types";

type Expectation = {
  action?: string;
  sku?: string;
  contains?: string;
  skill?: string;
  behavior?: string;
  emotion?: string;
  durable?: string;
  noDurableTravel?: boolean;
  noRecommendation?: boolean;
  maxQuestions?: number;
};
type EvalCase = { id: string; group: string; turns: string[]; expect: Expectation };

const cases = JSON.parse(await readFile(new URL("../evals/conversation-cases.json", import.meta.url), "utf8")) as EvalCase[];
assert.equal(cases.length, 50, "评测集必须固定为 50 条");

let passed = 0;
const failures: string[] = [];
for (const item of cases) {
  try {
    let state: UserState = { facts: {}, history: [], turn: 0 };
    let previous: DecisionResult | null = null;
    let understanding: TurnUnderstanding = deterministicUnderstand(item.turns[0]);
    for (const text of item.turns) {
      understanding = mergeUnderstanding(null, deterministicUnderstand(text));
      state = applyDelta(state, understanding.delta);
      const draft = decide(state);
      const plan = planConversation({
        draft,
        state,
        signals: understanding.signals,
        lifestyle: understanding.lifestyle,
        memories: [],
        previousResult: previous,
        updatedFields: understanding.delta.updates.map((entry) => entry.field),
      });
      const copy = renderTemplate(plan, understanding.signals);
      previous = { ...draft, action: plan.policy.nextAction, questionFields: plan.policy.selectedQuestionFields, recommendations: plan.policy.nextAction === "close" ? [] : draft.recommendations, reply: copy.reply, questions: copy.questions, state, audits: [], turnSignals: understanding.signals, lifestyle: understanding.lifestyle, conversationPolicy: plan.policy, render: { source: "template", validationPassed: true, factBlockIds: copy.factBlockIds }, versions: { input: state.turn, state: state.turn, knowledge: "eval" } };
    }
    assert(previous);
    const expected = item.expect;
    if (expected.action) assert.equal(previous.action, expected.action);
    if (expected.sku) assert.equal(previous.recommendations.some((entry) => entry.sku === expected.sku), true);
    if (expected.contains) assert.match(previous.reply, new RegExp(expected.contains.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    if (expected.skill) assert.equal(previous.conversationPolicy.taskSkill, expected.skill);
    if (expected.behavior) assert.equal(previous.conversationPolicy.behaviorSkills.includes(expected.behavior as never), true);
    if (expected.emotion) assert.equal(previous.conversationPolicy.userEmotion, expected.emotion);
    if (expected.noRecommendation) assert.equal(previous.recommendations.length, 0);
    if (expected.maxQuestions !== undefined) assert.equal(previous.questions.length <= expected.maxQuestions, true);
    if (expected.durable) assert.equal(understanding.lifestyle.some((entry) => entry.kind === expected.durable && entry.scope === "durable" && entry.subject === "self"), true);
    if (expected.noDurableTravel) assert.equal(understanding.lifestyle.some((entry) => entry.kind === "frequent_travel" && entry.scope === "durable"), false);
    passed += 1;
  } catch (error) {
    failures.push(`${item.id} ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log(JSON.stringify({ configuration: { extractor: "local-frozen-v1", renderer: "template-frozen-v1", caseCount: cases.length }, passed, failed: failures.length, failures }, null, 2));
if (failures.length) process.exitCode = 1;
