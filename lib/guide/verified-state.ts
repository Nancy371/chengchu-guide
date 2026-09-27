import { applyDelta, deterministicUnderstand, mergeUnderstanding, validateUnderstanding } from "./state";
import type { ModelAudit, StateDelta, TurnUnderstanding, UserState } from "./types";

type ExtractResult = { proposal?: unknown; understanding?: TurnUnderstanding | null; audit: ModelAudit };
type Extractor = (text: string, state: UserState) => Promise<ExtractResult>;

export interface VerifiedStateResult {
  state: UserState;
  understanding: TurnUnderstanding;
  rejectedProposals: Array<{ field: unknown; quote: unknown; reason: string }>;
  audit: {
    mode: "model" | "local_fallback";
    updatedFields: StateDelta["updates"][number]["field"][];
    model?: ModelAudit;
  };
}

/** The sole state transition used by normal turns and recovery. */
export const verifiedState = {
  async update(args: { currentState: UserState; userMessage: string; pendingQuestion?: StateDelta["updates"][number]["field"]; extract?: Extractor }): Promise<VerifiedStateResult> {
    const local = deterministicUnderstand(args.userMessage, args.pendingQuestion);
    let understanding = local;
    let modelAudit: ModelAudit | undefined;
    const rejectedProposals: VerifiedStateResult["rejectedProposals"] = [];
    if (args.extract) {
      try {
        const extraction = await args.extract(args.userMessage, args.currentState);
        modelAudit = extraction.audit;
        const proposed = extraction.proposal;
        const validated = proposed === undefined ? extraction.understanding ?? null : validateUnderstanding(proposed, args.userMessage);
        if (proposed && typeof proposed === "object" && Array.isArray((proposed as { updates?: unknown }).updates)) {
          const accepted = validated?.delta.updates ?? [];
          for (const item of (proposed as { updates: unknown[] }).updates) {
            const candidate = item as { field?: unknown; quote?: unknown; value?: unknown } | null;
            if (!candidate || !accepted.some((valid) => valid.field === candidate.field && valid.quote === candidate.quote && JSON.stringify(valid.value) === JSON.stringify(candidate.value))) {
              rejectedProposals.push({ field: candidate?.field, quote: candidate?.quote, reason: "unverified_current_message_evidence_or_value" });
            }
          }
        }
        understanding = mergeUnderstanding(validated, local);
        modelAudit = { ...modelAudit, businessAccepted: Boolean(validated), used: Boolean(validated?.delta.updates.length || validated?.signals.length || validated?.lifestyle.length) };
      } catch {
        modelAudit = { stage: "extract", model: "unknown", modelInvoked: true, parseSuccess: false, schemaSuccess: false, businessAccepted: false, used: false, latencyMs: 0, failureReason: "extractor_threw" };
      }
    }
    const state = applyDelta(args.currentState, understanding.delta);
    return {
      state,
      understanding,
      rejectedProposals,
      audit: { mode: args.extract ? "model" : "local_fallback", updatedFields: understanding.delta.updates.map((item) => item.field), ...(modelAudit ? { model: modelAudit } : {}) },
    };
  },
};
