import assert from "node:assert/strict";
import test from "node:test";
import { checkEligibility } from "../lib/guide/tools";
import { questionOptions } from "../lib/guide/question-options";
import { applyDelta, deterministicUnderstand } from "../lib/guide/state";
import type { UserState } from "../lib/guide/types";

function state(text: string) {
  return applyDelta({ facts: {}, history: [], turn: 0 } as UserState, deterministicUnderstand(text).delta);
}

test("budget choices follow verified catalog price tiers for a single category or bundle", () => {
  const cleanser = state("想买洗面奶");
  const fits = checkEligibility({ skus: ["P101", "P102", "P202", "P203"], userState: cleanser }).fits;
  assert.deepEqual(questionOptions("budget", fits, cleanser).map((item) => item.label), ["¥150 以内", "¥200 以内", "不限预算", "暂时不说"]);
  const bundle = state("想配洁面和保湿");
  assert.deepEqual(questionOptions("budget", fits, bundle).map((item) => item.label), ["¥400 以内", "¥450 以内", "不限预算", "暂时不说"]);
});

test("every active question field has canonical choices and custom input remains a UI action", () => {
  const current = state("想买洗面奶");
  for (const field of ["categories", "giftBoxType", "skinType", "fragrancePreference", "currentDiscomfort", "sensitiveTendency", "acidExperience", "texturePreference", "coreConcern"] as const) {
    const options = questionOptions(field, [], current);
    assert.ok(options.length >= 2, field);
    assert.equal(new Set(options.map((item) => item.id)).size, options.length, field);
    assert.ok(options.every((item) => item.answerText.length > 0), field);
  }
});
