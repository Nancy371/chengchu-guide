export type StateField =
  | "intent"
  | "targetSku"
  | "categories"
  | "budget"
  | "budgetScope"
  | "skinType"
  | "sensitiveTendency"
  | "currentDiscomfort"
  | "stinging"
  | "pain"
  | "skinDamage"
  | "otherDiscomfort"
  | "fragrancePreference"
  | "fragranceNote"
  | "acidExperience"
  | "existingProducts"
  | "travelNeed"
  | "useOccasions"
  | "texturePreference"
  | "delegateChoice"
  | "coreConcern"
  | "channelPreference"
  | "claimedOnlinePrice"
  | "giftBoxType"
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
  /** Unresolved aggregate risk from a session saved before symptom facts existed. */
  unresolvedLegacyDiscomfort?: boolean;
  purchaseTask?: PurchaseTask;
}

export type PurchaseTurnActionKind = "answer_question" | "switch_goal" | "request_alternative" | "price_interruption" | "policy_interruption" | "decline_answer" | "end" | "continue";
export interface PurchaseTurnAction { kind: PurchaseTurnActionKind; quote: string }
export interface PurchaseGoal {
  kind: "categories" | "gift_box_ambiguous" | "unsupported_skincare_gift_box";
  categories: Product["category"][];
  targetSku?: string;
  version: number;
  key: string;
}
export interface PurchaseTask {
  goal: PurchaseGoal;
  pendingQuestion?: { field: StateField; askedCount: number; reason: string };
  questionCounts?: Partial<Record<StateField, number>>;
  displayedSkus: string[];
  turnAction: PurchaseTurnAction;
  budget: { status: "unknown" | "limited" | "unlimited" | "declined"; fen?: number; goalVersion: number };
  updatedTurn: number;
}

export type SignalKind = "emotion" | "communication" | "lifestyle";
export type SignalValue =
  | "worried" | "frustrated" | "hesitant" | "happy"
  | "price_objection" | "reject" | "correction" | "hurry" | "direct_answer" | "answer_ambiguous" | "decline_answer"
  | "morning_rush" | "exercise" | "travel" | "simple_routine" | "existing_routine" | "sensory_discomfort";

export interface TurnSignal {
  kind: SignalKind;
  value: SignalValue;
  quote: string;
  explicit: boolean;
  subject: "self" | "other" | "unknown";
  temporal?: "current" | "historical" | "unclear";
}

export type HabitKind = "routine_preference" | "frequent_travel" | "fragrance_preference" | "texture_preference" | "purchase_preference";

export interface LifestyleObservation {
  kind: HabitKind;
  value: string | boolean;
  quote: string;
  scope: "turn" | "session" | "durable";
  explicit: boolean;
  subject: "self" | "other" | "unknown";
}

export interface TurnUnderstanding {
  delta: StateDelta;
  signals: TurnSignal[];
  lifestyle: LifestyleObservation[];
  purchaseAction?: PurchaseTurnAction;
}

export interface HabitMemory {
  id: string;
  kind: HabitKind;
  value: string | boolean;
  sourceTurn: number;
  updatedAt: number;
  expiresAt: number;
}

export interface MemoryProfile {
  authenticated: boolean;
  enabled: boolean;
  version: number;
  memories: HabitMemory[];
  account?: { displayName: string; email: string };
}

export type ConversationTaskSkill = "clarification" | "recommendation" | "budget_conflict" | "price_objection" | "discomfort" | "decision_support" | "conversation_repair";
export type ConversationBehaviorSkill = "emotion_acknowledgement" | "pace_adaptation" | "routine_fit" | "existing_routine_respect" | "occasion_fit" | "sensory_preference" | "gentle_recall" | "respectful_close";
export type ConversationAct = "acknowledge" | "reduce_pressure" | "explain_reason" | "state_fact" | "state_limit" | "offer_tradeoff" | "ask_question" | "repair_understanding" | "close_respectfully";

export interface ConversationPolicy {
  taskSkill: ConversationTaskSkill;
  behaviorSkills: ConversationBehaviorSkill[];
  userEmotion: "neutral" | "worried" | "frustrated" | "hesitant" | "happy" | "discomfort";
  relationshipStage: "early" | "exploring" | "evaluating" | "repair";
  nextAction: DecisionAction;
  conversationActs: ConversationAct[];
  tone: "light_warm" | "calm_direct";
  pressureLevel: "low";
  selectedQuestionFields: StateField[];
  responseLength: "short" | "medium";
  shouldAcknowledge: boolean;
  shouldExplainReason: boolean;
  emojiPolicy: "optional_one" | "none";
  acknowledgedSignal?: TurnSignal;
  usedMemory?: Pick<HabitMemory, "id" | "kind" | "value">;
}

export interface RenderMetadata {
  source: "model" | "template";
  validationPassed: boolean;
  fallbackReason?: string;
  factBlockIds: string[];
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
  safetyStatus?: "active_risk" | "unclear" | "explicitly_stable" | "not_provided";
  hardConstraintMatch?: boolean;
  budgetStatus?: "within" | "unknown" | "over";
  fitEvidenceIds?: string[];
  productFactIds?: string[];
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
  stage: "extract" | "planner" | "reason" | "normalize" | "render" | "render_review";
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
  | "comparison_only"
  | "recommend"
  | "price_list"
  | "price_answer"
  | "policy_unknown"
  | "budget_conflict"
  | "safety"
  | "close"
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
  pricingMode?: "single" | "bundle" | "alternatives";
}

export interface DecisionResult extends DecisionDraft {
  reply: string;
  questions: string[];
  state: UserState;
  audits: ModelAudit[];
  turnSignals: TurnSignal[];
  lifestyle: LifestyleObservation[];
  conversationPolicy: ConversationPolicy;
  render: RenderMetadata;
  versions: {
    input: number;
    state: number;
    knowledge: string;
  };
  decisionTrace?: DecisionTrace;
  agentTrace?: AgentTrace;
  clarification?: ClarificationProgress;
  purchaseTask?: PurchaseTask;
}

export interface ClarificationProgress {
  goalKey: string;
  candidateKey: string;
  field: StateField;
  askedCount: number;
  reason: string;
}

export type DecisionToolName = "search_products" | "get_product_detail" | "check_safety" | "check_eligibility" | "check_budget" | "compare_products" | "lookup_policy";
export interface ToolObservation { order: number; tool: DecisionToolName; outcome: string; data?: unknown }
export interface DecisionTrace {
  tools: Array<{ tool: DecisionToolName; outcome: string }>;
  eligibility: Array<{ sku: string; status: ProductFit["status"] }>;
  versions: DecisionResult["versions"];
  routeReason: string;
  candidateEvaluation?: Pick<CandidateEvaluation, "requiredGap" | "selectedQuestion" | "outcome" | "questionImpact">;
}

export interface CandidateEvaluation {
  productFits: ReadonlyArray<ProductFit>;
  rejected: AgentContext["rejectedProducts"];
  requiredGap?: StateField;
  selectedQuestion?: StateField;
  questionImpact?: string;
  outcome: "safety" | "clarify" | "ready" | "compare" | "budget_conflict" | "unavailable";
  versions: DecisionResult["versions"];
}

export interface AgentContext {
  goal: { type: "buy_product" | "price" | "policy" | "unknown"; categories: string[]; targetSku?: string };
  userState: Readonly<UserState>;
  habits: { version: number; relevant: ReadonlyArray<HabitMemory> };
  candidateProducts: ReadonlyArray<ProductFit>;
  rawCandidateSkus: ReadonlyArray<string>;
  productFits: ReadonlyArray<ProductFit>;
  rejectedProducts: ReadonlyArray<{ sku: string; reason: string; stage: "safety" | "eligibility" | "hard_constraint" | "budget" | "already_displayed" }>;
  candidateEvaluation?: CandidateEvaluation;
  hardConstraints: { safety: "active_risk" | "unclear" | "explicitly_stable" | "not_provided"; budgetStatus: PurchaseTask["budget"]["status"]; budgetFen?: number; fragranceFree: boolean };
  softPreferences: { skinType?: string; fragrance?: string; concern?: string };
  requiredMissingFields: ReadonlyArray<StateField>;
  currentDecision: DecisionDraft | null;
  completedActions: ReadonlyArray<DecisionToolName>;
  observations: ReadonlyArray<ToolObservation>;
  pendingQuestions: ReadonlyArray<StateField>;
  clarification?: ClarificationProgress;
  purchaseTask: Readonly<PurchaseTask>;
  allowedActions: ReadonlyArray<PlannerAction["action"]>;
  step: number;
  remainingTimeBudget: number;
  versions: DecisionResult["versions"];
}

export type PlannerAction =
  | { action: "search_products"; arguments: { category: Product["category"] }; evidenceNeeded: string; expectedProgress: string }
  | { action: "compare_products"; arguments: { skus: string[] }; evidenceNeeded: string; expectedProgress: string }
  | { action: "ask_user"; arguments: { field: StateField }; evidenceNeeded: string; expectedProgress: string }
  | { action: "finalize"; arguments: Record<string, never>; evidenceNeeded: string; expectedProgress: string };

export type FinalDecisionProposal =
  | { kind: "recommend"; skus: string[]; evidenceIds: string[]; relation: "single" | "bundle" | "alternatives" }
  | { kind: "ask"; field: StateField; questionGoal: string; evidenceGap: string }
  | { kind: "comparison_only"; skus: string[]; evidenceIds: string[]; field: StateField }
  | { kind: "price_list"; skus: string[]; evidenceIds: string[] }
  | { kind: "direct"; source: "rule" | "fallback"; reason: string; action?: "close" | "unavailable" };

export interface FinalAuthorizationResult {
  status: "APPROVED" | "REJECTED" | "STALE" | "FALLBACK_REQUIRED";
  reason: string;
  decision?: DecisionDraft;
}

export interface AgentTrace {
  planner: Array<{ step: number; action: string; policy: "allowed" | "rejected"; reason: string }>;
  observations: Array<{ order: number; tool: DecisionToolName; outcome: string }>;
  reasonerProposal?: Extract<FinalDecisionProposal, { kind: "recommend" | "ask" }>;
  authorization: FinalAuthorizationResult["status"];
  authorizationReason: string;
  fallbackReason?: string;
  versions: DecisionResult["versions"];
}

export interface SessionRecord {
  id: string;
  userId: string | null;
  state: UserState;
  inputVersion: number;
  appliedInputVersion: number;
  stateVersion: number;
  result: DecisionResult | null;
}
