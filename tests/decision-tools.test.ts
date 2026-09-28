import assert from "node:assert/strict";
import test from "node:test";
import { applyDelta, deterministicExtract } from "../lib/guide/state";
import { checkBudget, checkEligibility, checkSafety, compareProducts, getProductDetail, lookupPolicy, searchProducts } from "../lib/guide/tools";
import type { UserState } from "../lib/guide/types";

function stateFrom(...turns: string[]): UserState {
  return turns.reduce((state, text) => applyDelta(state, deterministicExtract(text)), { facts: {}, history: [], turn: 0 } as UserState);
}

test("catalog tools expose only manual-backed products and identify unknown SKU", () => {
  assert.deepEqual(searchProducts({ category: "cleanser" }).products.map((product) => product.sku), ["P101", "P102"]);
  assert.deepEqual(searchProducts({ skus: ["P101", "P999"] }).unknownSkus, ["P999"]);
  assert.equal(getProductDetail({ sku: "P102" }).product?.priceFen, 14900);
  assert.deepEqual(getProductDetail({ sku: "P999" }), { product: null, source: null });
});

test("safety distinguishes active, unclear, stable and absent evidence", () => {
  assert.equal(checkSafety({ userState: stateFrom("没有刺痛，但皮肤破损") }).status, "active_risk");
  assert.equal(checkSafety({ userState: stateFrom("皮肤有点不舒服") }).status, "unclear");
  assert.equal(checkSafety({ userState: stateFrom("现在状态稳定") }).status, "explicitly_stable");
  const absent = checkSafety({ userState: stateFrom("想买果酸") });
  assert.equal(absent.status, "not_provided");
  assert.equal(absent.blocksAcid, true);
});

test("sensitive tendency does not become an unsupported claim of current stability", () => {
  const state = stateFrom("我是敏感肌，想买洗面奶");
  const fit = checkEligibility({ skus: ["P101"], userState: state }).fits[0];
  assert.equal(fit.status, "needs_information");
  assert.equal(fit.missing.includes("currentDiscomfort"), true);
  assert.equal(fit.matches.some((item) => item.includes("当前稳定")), false);
});

test("eligibility respects damage, acid experience and hard fragrance preference", () => {
  const damaged = checkEligibility({ skus: ["P201"], userState: stateFrom("我想买果酸，皮肤破损，用过果酸，不敏感") });
  assert.equal(damaged.rejected[0]?.sku, "P201");
  const unknownSafety = checkEligibility({ skus: ["P201"], userState: stateFrom("我想买果酸，用过果酸，不敏感") });
  assert.equal(unknownSafety.needsInformation[0]?.fields.includes("currentDiscomfort"), true);
  const novice = checkEligibility({ skus: ["P201"], userState: stateFrom("我想买果酸，没用过果酸，现在状态稳定，不敏感") });
  assert.equal(novice.rejected[0]?.sku, "P201");
  const noFragrance = checkEligibility({ skus: ["P101", "P102", "P999"], userState: stateFrom("想买洗面奶，我必须无香") });
  assert.equal(noFragrance.eligible.includes("P101"), true);
  assert.equal(noFragrance.rejected.some((item) => item.sku === "P102"), true);
  assert.deepEqual(noFragrance.unknownSkus, ["P999"]);
});

test("budget quotes bundles as totals and alternatives separately", () => {
  assert.equal(checkBudget({ skus: ["P101", "P202"], mode: "bundle", budgetFen: 40000 }).totalFen, 42800);
  assert.equal(checkBudget({ skus: ["P102", "P203"], mode: "bundle", budgetFen: 40000 }).totalFen, 36800);
  const alternatives = checkBudget({ skus: ["P101", "P102"], mode: "alternatives", budgetFen: 15000 });
  assert.equal(alternatives.totalFen, undefined);
  assert.deepEqual(alternatives.lines.map((line) => line.withinBudget), [false, true]);
  assert.equal(checkBudget({ skus: ["P999"], mode: "single" }).withinBudget, null);
});

test("comparison does not add claims and unknown gifts do not hide verified price", () => {
  const state = stateFrom("我是干皮，想买洗面奶");
  const fits = checkEligibility({ skus: ["P101"], userState: state }).fits;
  const comparison = compareProducts({ skus: ["P101", "P999"], fits });
  assert.deepEqual(comparison.items[0]?.fit?.allowedClaims, fits[0].allowedClaims);
  assert.deepEqual(comparison.unknownSkus, ["P999"]);
  assert.equal(lookupPolicy({ topics: ["gift"] }).items[0]?.status, "unknown");
  assert.equal(getProductDetail({ sku: "P101" }).product?.priceFen, 16900);
});
