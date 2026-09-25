export type StateField =
  | "intent"
  | "targetSku"
  | "categories"
  | "budget"
  | "budgetScope"
  | "skinType"
  | "sensitiveTendency"
  | "currentDiscomfort"
  | "fragrancePreference"
  | "acidExperience"
  | "existingProducts"
  | "travelNeed"
  | "coreConcern"
  | "channelPreference"
  | "claimedOnlinePrice"
  | "policyTopics";

export type FactValue = string | number | boolean | string[];

export interface SourcedFact {
  field: StateField;
  value: FactValue;
  quote: string;
  turn: number;
  status: "confirmed" | "unclear";
  extractedBy: "model" | "local";
}

export interface StateDelta {
  updates: Array<Omit<SourcedFact, "turn">>;
  extraction: "model" | "local";
  warnings: string[];
}

export interface UserState {
  facts: Partial<Record<StateField, SourcedFact>>;
  history: SourcedFact[];
  pendingQuestion?: string;
  turn: number;
}

export interface Product {
  sku: string;
  name: string;
  priceFen: number;
  size: string;
  category: "cleanser" | "serum" | "moisturizer" | "travel";
  features: string[];
  suitable: string[];
  limitations: string[];
  fragrance: "none" | "fragranced" | "not_applicable";
  source: string;
}

export interface ProductFit {
  sku: string;
  status: "eligible" | "needs_information" | "excluded";
  score: number;
  matches: string[];
  blockers: string[];
  missing: string[];
  tradeoffs: string[];
  allowedClaims: string[];
  evidence: EvidenceItem[];
}

export interface EvidenceItem {
  id: string;
  label: string;
  detail: string;
  source: string;
  status: "supported" | "contradicted" | "unknown" | "not_applicable";
}

export interface Recommendation {
  sku: string;
  name: string;
  priceFen: number;
  quantity: number;
  reasons: string[];
  tradeoffs: string[];
}

export interface ModelAudit {
  stage: "extract" | "reason" | "normalize";
  model: string;
  modelInvoked: boolean;
  parseSuccess: boolean;
  schemaSuccess: boolean;
  businessAccepted: boolean;
  used: boolean;
  latencyMs: number;
  failureReason?: string;
}

export type DecisionAction =
  | "clarify"
  | "recommend"
  | "price_answer"
  | "policy_unknown"
  | "budget_conflict"
  | "safety"
  | "unavailable";

export interface DecisionDraft {
  action: DecisionAction;
  route: "safety" | "direct" | "reasoning" | "degraded";
  routeReason: string;
  questionFields: StateField[];
  candidateSkus: string[];
  recommendations: Recommendation[];
  productFits: ProductFit[];
  evidence: EvidenceItem[];
  limitations: string[];
  totalFen?: number;
  budgetGapFen?: number;
}

export interface DecisionResult extends DecisionDraft {
  reply: string;
  questions: string[];
  state: UserState;
  audits: ModelAudit[];
  versions: {
    input: number;
    state: number;
    knowledge: string;
  };
}

export interface SessionRecord {
  id: string;
  state: UserState;
  inputVersion: number;
  stateVersion: number;
  result: DecisionResult | null;
}
