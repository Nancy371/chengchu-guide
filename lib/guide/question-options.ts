import { PRODUCTS_BY_SKU } from "./catalog";
import { fact } from "./state";
import type { ProductFit, QuestionOption, StateField, UserState } from "./types";

const option = (id: string, label: string, answerText: string): QuestionOption => ({ id, label, answerText });

function budgetOptions(fits: readonly ProductFit[], state: UserState): QuestionOption[] {
  const categories = fact<string[]>(state, "categories") ?? [];
  const prices = fits.filter((fit) => categories.includes(PRODUCTS_BY_SKU[fit.sku]?.category))
    .map((fit) => PRODUCTS_BY_SKU[fit.sku].priceFen / 100);
  const bundle = categories.includes("cleanser") && categories.includes("moisturizer");
  const raw = bundle ? [368, 428] : prices;
  const tiers = [...new Set(raw.map((price) => Math.ceil(price / 50) * 50))].sort((a, b) => a - b).slice(0, 2);
  return [
    ...tiers.map((amount) => option(`budget-${amount}`, `¥${amount} 以内`, `预算${amount}`)),
    option("budget-unlimited", "不限预算", "不限预算"),
    option("budget-decline", "还没想好，先看看", "预算还没想好，想先看看价格"),
  ];
}

export function questionOptions(field: StateField | undefined, fits: readonly ProductFit[], state: UserState): QuestionOption[] {
  if (!field) return [];
  if (field === "budget") return budgetOptions(fits, state);
  const options: Partial<Record<StateField, QuestionOption[]>> = {
    categories: [
      option("category-cleanser", "洁面", "想买洗面奶"),
      option("category-moisturizer", "保湿", "想买保湿面霜"),
      option("category-serum", "果酸精华", "想买果酸精华"),
      option("category-travel", "旅行分装", "想要旅行分装瓶礼盒"),
    ],
    giftBoxType: [
      option("gift-travel", "旅行分装瓶礼盒", "想要旅行分装瓶礼盒"),
      option("gift-skincare", "护肤品礼盒", "想要护肤品礼盒"),
    ],
    skinType: [
      option("skin-dry", "更容易干或紧绷", "我是干皮"),
      option("skin-oily", "更容易出油", "我是油皮"),
      option("skin-unsure", "说不清", "不太确定"),
    ],
    fragrancePreference: [
      option("scent-free", "希望无香", "必须无香"),
      option("scent-okay", "能接受香味", "能接受香味"),
      option("scent-sensitive", "对香味敏感", "我对香味敏感"),
      option("scent-neutral", "都可以", "都可以"),
    ],
    currentDiscomfort: [
      option("safety-active", "现在仍有明显不适", "现在有明显不适"),
      option("safety-clear", "目前没有不适", "目前没有不适"),
      option("safety-unsure", "说不清", "不太确定"),
      option("safety-decline", "暂不回答", "不方便说"),
    ],
    sensitiveTendency: [
      option("sensitive-yes", "平时容易敏感", "我平时容易敏感"),
      option("sensitive-no", "平时不敏感", "我平时不敏感"),
      option("sensitive-unsure", "说不清", "不太确定"),
    ],
    acidExperience: [
      option("acid-yes", "用过果酸", "我用过果酸"),
      option("acid-no", "没用过果酸", "我没用过果酸"),
      option("acid-unsure", "说不清", "不太确定"),
    ],
    texturePreference: [
      option("texture-light", "喜欢轻薄", "喜欢轻薄质地"),
      option("texture-avoid-sticky", "不喜欢黏", "不喜欢黏"),
      option("texture-neutral", "都可以", "都可以"),
    ],
    coreConcern: [
      option("concern-rough", "改善粗糙", "希望改善粗糙"),
      option("concern-fresh", "清爽肤感", "更喜欢清爽肤感"),
      option("concern-simple", "步骤简单", "想要简单护理"),
    ],
  };
  return options[field] ?? [option(`${field}-unsure`, "暂时说不清", "不太确定")];
}
