import { env } from "cloudflare:workers";
import { effectiveStateView, validateUnderstanding } from "./state";
import { validateRenderProposal, type ConversationPlan, type RenderedCopy } from "./conversation";
import type { DecisionDraft, ModelAudit, TurnUnderstanding, UserState } from "./types";

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
  private renderModel = runtimeEnv("DEEPSEEK_RENDER_MODEL") ?? "deepseek-flash";

  private modelFor(stage: Stage): string {
    if (stage === "reason") return this.reasonModel;
    if (stage === "normalize") return this.normalizeModel;
    if (stage === "render") return this.renderModel;
    return this.extractModel;
  }

  private emptyAudit(stage: Stage, reason: string): ModelAudit {
    return { stage, model: this.modelFor(stage), modelInvoked: false, parseSuccess: false, schemaSuccess: false, businessAccepted: false, used: false, latencyMs: 0, failureReason: reason };
  }

  private async invoke(stage: Stage, messages: Array<{ role: string; content: string }>, timeoutMs: number, thinking: boolean, responseFormat = false, maxTokens?: number) {
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
          max_tokens: maxTokens ?? (thinking ? 2048 : 900),
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

  async extract(text: string, state: UserState): Promise<{ understanding: TurnUnderstanding | null; audit: ModelAudit }> {
    const result = await this.invoke("extract", [
      { role: "system", content: "你只负责从当前用户消息提取导购状态增量、明确的当轮信号和生活偏好观察。只输出 JSON：{updates:[{field,value,quote,status}],signals:[{kind,value,quote,explicit,subject,temporal}],lifestyle:[{kind,value,quote,scope,explicit,subject}]}。quote 必须逐字来自当前消息。情绪只在用户明确表达时标 explicit=true；temporal 只能是 current、historical、unclear。预算低不代表焦虑，短句不代表生气。识别否定、过去经历、替别人咨询。不要计算价格、推荐商品或推测未说的信息。可用 signal value：worried,frustrated,hesitant,happy,price_objection,reject,correction,hurry,direct_answer,morning_rush,exercise,travel,simple_routine,existing_routine,sensory_discomfort。可用 lifestyle kind：routine_preference,frequent_travel,fragrance_preference,texture_preference,purchase_preference。" },
      { role: "user", content: JSON.stringify({ currentState: effectiveStateView(state), currentMessage: text }, null, 2) },
    ], 8000, false, true);
    const understanding = validateUnderstanding(result.value, text);
    const accepted = understanding !== null;
    return { understanding, audit: { ...result.audit, schemaSuccess: accepted, businessAccepted: accepted, used: accepted } };
  }

  async reason(state: UserState, draft: DecisionDraft, deadlineAt = Number.POSITIVE_INFINITY): Promise<{ proposal: unknown; audits: ModelAudit[] }> {
    const reasonBudget = Math.min(24000, deadlineAt - Date.now());
    if (reasonBudget < 500) return { proposal: null, audits: [this.emptyAudit("reason", "deadline_exhausted")] };
    const result = await this.invoke("reason", [
      { role: "system", content: "你是导购决策复核器。只可在 candidateFits 中未排除的 SKU 内排序，或从 allowedQuestionFields 中选择最多两个追问字段。不得修改价格、商品事实、用户已确认状态或规则。最终 content 只输出 JSON：{candidateSkus:string[],questionFields:string[]}。" },
      { role: "user", content: JSON.stringify({ currentState: effectiveStateView(state), routeReason: draft.routeReason, candidateFits: draft.productFits, allowedQuestionFields: draft.questionFields }, null, 2) },
    ], reasonBudget, true, false);
    if (result.value) return { proposal: result.value, audits: [{ ...result.audit, businessAccepted: true, used: true }] };
    if (!result.raw) return { proposal: null, audits: [result.audit] };
    const normalizeBudget = Math.min(6000, deadlineAt - Date.now());
    if (normalizeBudget < 500) return { proposal: null, audits: [result.audit, this.emptyAudit("normalize", "deadline_exhausted")] };
    const normalized = await this.invoke("normalize", [
      { role: "system", content: "只修复以下内容的 JSON 表示。不得新增候选、事实、理由或问题。输出 JSON：{candidateSkus:string[],questionFields:string[]}。" },
      { role: "user", content: result.raw },
    ], normalizeBudget, false, true);
    return { proposal: normalized.value, audits: [result.audit, { ...normalized.audit, businessAccepted: normalized.value !== null, used: normalized.value !== null }] };
  }

  async render(plan: ConversationPlan, timeoutMs = 6000): Promise<{ copy: RenderedCopy | null; audit: ModelAudit }> {
    if (timeoutMs < 500) return { copy: null, audit: this.emptyAudit("render", "deadline_exhausted") };
    const result = await this.invoke("render", [
      { role: "system", content: "你是澄初导购的受控表达器，只负责承接、过渡、提问和收尾。事实句由 factBlocks 锁定，你只能在 blockIds 中排列，不能复述、改写或新增价格、SKU、功效、安全和政策事实。免费文本中不要出现数字、货币、SKU、医疗承诺、催单或虚构亲身经历。根据 policy 输出 JSON：{acknowledgement:string,blockIds:string[],questions:[{field:string,text:string}],closing:string,actsUsed:string[]}。questions 字段必须与 selectedQuestionFields 完全一致。语气自然、轻松、克制，不固定说“我理解你的心情”。" },
      { role: "user", content: JSON.stringify({ policy: plan.policy, factBlocks: plan.factBlocks, questionGoals: plan.questionGoals }, null, 2) },
    ], Math.min(6000, timeoutMs), false, true, 600);
    const copy = validateRenderProposal(result.value, plan);
    const accepted = copy !== null;
    return { copy, audit: { ...result.audit, schemaSuccess: result.value !== null, businessAccepted: accepted, used: accepted, ...(result.value !== null && !accepted ? { failureReason: "render_business_validation_failed" } : {}) } };
  }
}
