import type { Product } from "./types";

export const KNOWLEDGE_VERSION = "chengchu-manual-2026-09-v1";
export const MANUAL_SOURCE = "《澄初个人护理·智能导购品牌手册》P1";

export const PRODUCTS: Product[] = [
  {
    sku: "P101",
    name: "云感氨基酸舒润洁面乳",
    priceFen: 16900,
    size: "150ml",
    category: "cleanser",
    features: ["无香型", "低泡", "洗后易冲净"],
    suitable: ["偏干或敏感倾向用户可考虑"],
    limitations: ["个体差异，首次使用建议局部测试"],
    fragrance: "none",
    source: MANUAL_SOURCE,
  },
  {
    sku: "P102",
    name: "P102 洁面产品",
    priceFen: 14900,
    size: "150ml",
    category: "cleanser",
    features: ["清洁感较强", "带香味"],
    suitable: ["偏油且偏好清爽肤感者可考虑"],
    limitations: ["对香味敏感者不优先", "源文件名称缺字，完整名称待核"],
    fragrance: "fragranced",
    source: MANUAL_SOURCE,
  },
  {
    sku: "P201",
    name: "焕亮果酸细致精华液",
    priceFen: 22900,
    size: "30ml",
    category: "serum",
    features: ["含 8% 果酸复合成分"],
    suitable: ["有相关使用经验、希望改善粗糙者可考虑"],
    limitations: ["敏感、受损或正在不适的皮肤不推荐", "需注意防晒"],
    fragrance: "not_applicable",
    source: MANUAL_SOURCE,
  },
  {
    sku: "P202",
    name: "屏护神经酰胺保湿乳",
    priceFen: 25900,
    size: "50ml",
    category: "moisturizer",
    features: ["无香型", "含神经酰胺类保湿成分"],
    suitable: ["干燥、屏障脆弱倾向用户可考虑"],
    limitations: ["不承诺治疗", "明显不适建议咨询专业人士"],
    fragrance: "none",
    source: MANUAL_SOURCE,
  },
  {
    sku: "P203",
    name: "水漾轻盈保湿凝露",
    priceFen: 21900,
    size: "50ml",
    category: "moisturizer",
    features: ["清爽质地", "带淡香"],
    suitable: ["偏油、喜欢轻薄肤感者可考虑"],
    limitations: ["对香味敏感者不优先"],
    fragrance: "fragranced",
    source: MANUAL_SOURCE,
  },
  {
    sku: "P301",
    name: "随行旅行分装瓶礼盒",
    priceFen: 4900,
    size: "4 个可重复使用小瓶",
    category: "travel",
    features: ["适合出差、旅行携带"],
    suitable: ["旅行携带需求明确时可考虑"],
    limitations: ["不属于护肤功效产品"],
    fragrance: "not_applicable",
    source: MANUAL_SOURCE,
  },
];

export const PRODUCTS_BY_SKU = Object.fromEntries(PRODUCTS.map((product) => [product.sku, product]));

export const BUNDLES = {
  drySensitive: ["P101", "P202"],
  oilyFresh: ["P102", "P203"],
} as const;

export const UNSUPPORTED_POLICY_TOPICS: Record<string, string> = {
  promotion: "促销",
  gift: "赠品",
  online_price: "线上同价",
  return: "退换货",
  authorization: "渠道授权",
};
