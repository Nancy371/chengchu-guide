import { env } from "cloudflare:workers";
import { effectiveStateView, validateDelta } from "./state";
import type { DecisionDraft, ModelAudit, StateDelta, UserState } from "./types";

type Stage = ModelAudit["stage"];

function runtimeEnv(name: string): string | undefined {
  const bindings = env as unknown as Record<string, unknown>;
  const value = bindings[name] ?? process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function extractJson(value: string): unknown {
  const trimmed = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try { return JSON.parse(trimmed); } catch { return null; }
}

export class DeepSeekModelAdapter {
  private key = runtimeEnv("DEEPSEEK_API_KEY") ?? runtimeEnv("MODEL_API_KEY");
  private baseUrl = (runtimeEnv("DEEPSEEK_BASE_URL") ?? "https://api.deepseek.com").replace(/\/$/, "");
  private extractModel = runtimeEnv("DEEPSEEK_EXTRACT_MODEL") ?? "deepseek-flash";
  private reasonModel = runtimeEnv("DEEPSEEK_REASON_MODEL") ?? "deepseek-v4-pro";
  private normalizeModel = runtimeEnv("DEEPSEEK_NORMALIZE_MODEL") ?? "deepseek-flash";

  private modelFor(stage: Stage): string {
    if (stage === "reason") return this.reasonModel;
    if (stage === "normalize") return this.normalizeModel;
    return this.extractModel;
  }

  private emptyAudit(stage: Stage, reason: string): ModelAudit {
    return { stage, model: this.modelFor(stage), modelInvoked: false, parseSuccess: false, schemaSuccess: false, businessAccepted: false, used: false, latencyMs: 0, failureReason: reason };
  }

  private async invoke(stage: Stage, messages: Array<{ role: string; content: string }>, timeoutMs: number, thinking: boolean, responseFormat = false) {
    if (!this.key) return { value: null, audit: this.emptyAudit(stage, "model_not_configured") };
    const model = this.modelFor(stage);
    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${this.key}` },
        body: JSON.stringify({
          model,
          messages,
          max_tokens: thinking ? 2048 : 900,
          ...(responseFormat ? { response_format: { type: "json_object" } } : {}),
          thinking: { type: thinking ? "enabled" : "disabled" },
          ...(thinking ? { reasoning_effort: "high" } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`http_${response.status}`);
      const body = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
      const content = body.choices?.[0]?.message?.content ?? "";
      const value = extractJson(content);
      return {
        value,
        raw: content,
        audit: { stage, model, modelInvoked: true, parseSuccess: value !== null, schemaSuccess: value !== null, businessAccepted: false, used: false, latencyMs: Date.now() - started, ...(value === null ? { failureReason: "json_parse_failed" } : {}) } satisfies ModelAudit,
      };
    } catch (error) {
      const reason = error instanceof Error && error.name === "AbortError" ? "timeout" : error instanceof Error ? error.message : "request_failed";
      return { value: null, audit: { ...this.emptyAudit(stage, reason), modelInvoked: true, latencyMs: Date.now() - started } };
    } finally {
      clearTimeout(timeout);
    }
  }

  async extract(text: string, state: UserState): Promise<{ delta: StateDelta | null; audit: ModelAudit }> {
    const result = await this.invoke("extract", [
      { role: "system", content: "你只负责从当前用户消息提取导购状态增量。输出 JSON：{updates:[{field,value,quote,status}]}。quote 必须逐字来自当前消息。不要计算价格、推荐商品或推测未说的信息。" },
      { role: "user", content: JSON.stringify({ currentState: effectiveStateView(state), currentMessage: text }, null, 2) },
    ], 8000, false, true);
    const delta = validateDelta(result.value, text);
    const accepted = delta !== null;
    return { delta, audit: { ...result.audit, schemaSuccess: accepted, businessAccepted: accepted, used: accepted } };
  }

  async reason(state: UserState, draft: DecisionDraft): Promise<{ proposal: unknown; audits: ModelAudit[] }> {
    const result = await this.invoke("reason", [
      { role: "system", content: "你是导购决策复核器。只可在 candidateFits 中未排除的 SKU 内排序，或从 allowedQuestionFields 中选择最多两个追问字段。不得修改价格、商品事实、用户已确认状态或规则。最终 content 只输出 JSON：{candidateSkus:string[],questionFields:string[]}。" },
      { role: "user", content: JSON.stringify({ currentState: effectiveStateView(state), routeReason: draft.routeReason, candidateFits: draft.productFits, allowedQuestionFields: draft.questionFields }, null, 2) },
    ], 24000, true, false);
    if (result.value) return { proposal: result.value, audits: [{ ...result.audit, businessAccepted: true, used: true }] };
    if (!result.raw) return { proposal: null, audits: [result.audit] };
    const normalized = await this.invoke("normalize", [
      { role: "system", content: "只修复以下内容的 JSON 表示。不得新增候选、事实、理由或问题。输出 JSON：{candidateSkus:string[],questionFields:string[]}。" },
      { role: "user", content: result.raw },
    ], 6000, false, true);
    return { proposal: normalized.value, audits: [result.audit, { ...normalized.audit, businessAccepted: normalized.value !== null, used: normalized.value !== null }] };
  }
}
