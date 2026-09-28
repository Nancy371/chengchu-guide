import assert from "node:assert/strict";

const base = process.argv[2] ?? "http://127.0.0.1:8787";

async function session() {
  const response = await fetch(`${base}/api/session`, { method: "POST" });
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  return cookie;
}

async function chat(cookie, requestId, text) {
  const response = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ requestId, text }),
  });
  if (response.status !== 200) throw new Error(`${requestId}: ${response.status} ${await response.text()}`);
  return response.json();
}

async function reload(cookie) {
  const response = await fetch(`${base}/api/session`, { headers: { cookie }, cache: "no-store" });
  assert.equal(response.status, 200);
  return response.json();
}

for (const [skin, expected] of [["我是干皮", "dry"], ["我是干性皮肤", "dry"], ["干", "dry"], ["我是油皮", "oily"], ["我是油性皮肤", "oily"], ["出油", "oily"], ["油", "oily"]]) {
  const cookie = await session();
  const first = await chat(cookie, "first", "想买洗面奶");
  assert.deepEqual(first.result.questionFields, ["skinType"]);
  const second = await chat(cookie, "second", skin);
  assert.equal(second.result.state.facts.skinType.value, expected);
  assert.equal(second.result.questionFields.includes("skinType"), false);
  const loaded = await reload(cookie);
  assert.equal(loaded.session.state.facts.skinType.value, expected);
  assert.equal(loaded.session.result.questionFields.includes("skinType"), false);
  assert.equal(loaded.session.appliedInputVersion, 2);
}

{
  const cookie = await session();
  const mixed = await chat(cookie, "mixed", "我想买果酸，我没有刺痛但皮肤破损，用过果酸，也不敏感");
  assert.equal(mixed.result.action, "safety");
  assert.deepEqual(mixed.result.recommendations, []);
  assert.equal(mixed.result.state.facts.stinging.value, false);
  assert.equal(mixed.result.state.facts.skinDamage.value, true);
}

{
  const cookie = await session();
  await chat(cookie, "old", "P101 多少钱");
  const changed = await chat(cookie, "changed", "我是干皮，现在只买保湿面霜");
  assert.equal(changed.result.state.facts.targetSku, undefined);
  assert.equal(changed.result.recommendations.every((item) => item.sku.startsWith("P2")), true);
}

{
  const cookie = await session();
  const painPromise = chat(cookie, "pain", "我现在脸很疼");
  await new Promise((resolve) => setTimeout(resolve, 10));
  const budgetPromise = chat(cookie, "budget", "预算300");
  await Promise.all([painPromise, budgetPromise]);
  const loaded = await reload(cookie);
  assert.equal(loaded.session.inputVersion, 2);
  assert.equal(loaded.session.appliedInputVersion, 2);
  assert.equal(loaded.session.state.facts.currentDiscomfort.value, true);
  assert.equal(loaded.session.state.facts.pain.value, true);
  assert.equal(loaded.session.state.facts.budget.value, 30000);
  assert.equal(loaded.session.result.action, "safety");
}

{
  const cookie = await session();
  const first = await chat(cookie, "same", "我现在脸很疼");
  const duplicate = await chat(cookie, "same", "我现在脸很疼");
  assert.equal(first.result.action, "safety");
  assert.equal(duplicate.duplicate, true);
  const loaded = await reload(cookie);
  assert.equal(loaded.session.inputVersion, 1);
  assert.equal(loaded.session.appliedInputVersion, 1);
  assert.equal(loaded.session.state.turn, 1);
}

{
  const cookie = await session();
  const first = await chat(cookie, "clarify-1", "想买洗面奶");
  assert.deepEqual(first.result.questionFields, ["skinType"]);
  const price = await chat(cookie, "clarify-price", "P101 多少钱");
  assert.equal(price.result.action, "price_answer");
  assert.equal(price.result.clarification.askedCount, 1);
  for (let count = 2; count <= 4; count++) {
    const answer = await chat(cookie, `clarify-${count}`, "还可以");
    assert.deepEqual(answer.result.questionFields, ["skinType"]);
    assert.equal(answer.result.clarification.askedCount, count);
  }
  const compared = await chat(cookie, "clarify-5", "还可以");
  assert.equal(compared.result.action, "comparison_only");
  assert.deepEqual(compared.result.recommendations, []);
  assert.match(compared.result.reply, /¥169/);
  assert.match(compared.result.reply, /¥149/);
  assert.equal(compared.result.totalFen, undefined);
}

{
  const cookie = await session();
  const first = await chat(cookie, "safety-1", "皮肤有点不舒服，想买洗面奶");
  assert.deepEqual(first.result.questionFields, ["currentDiscomfort"]);
  const refused = await chat(cookie, "safety-2", "不方便说");
  assert.equal(refused.result.action, "unavailable");
  assert.deepEqual(refused.result.recommendations, []);
  assert.deepEqual(refused.result.questions, []);
  const later = await chat(cookie, "safety-3", "还是想买洗面奶");
  assert.deepEqual(later.result.questionFields, ["currentDiscomfort"]);
}

console.log("Local D1 API: skin answers, refresh, sourced safety, category switch, concurrent inputs, idempotent retry, four-round clarification, factual comparison, safety refusal passed");
