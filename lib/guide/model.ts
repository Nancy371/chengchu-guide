import { env } from "cloudflare:workers";
import { effectiveStateView, validateUnderstanding } from "./state";
import { compileReasoningContext } from "./agent-context";
import { compilePlannerContext } from "./planner";
import { conversationLanguageRules, validateRenderProposal, type ConversationPlan, type RenderedCopy } from "./conversation";
import type { AgentContext, ModelAudit, TurnUnderstanding, UserState } from "./types";

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
  private plannerModel = runtimeEnv("DEEPSEEK_PLANNER_MODEL") ?? "deepseek-flash";
  private normalizeModel = runtimeEnv("DEEPSEEK_NORMALIZE_MODEL") ?? "deepseek-flash";
  private renderModel = runtimeEnv("DEEPSEEK_RENDER_MODEL") ?? "deepseek-flash";

  private modelFor(stage: Stage): string {
    if (stage === "reason") return this.reasonModel;
    if (stage === "planner") return this.plannerModel;
    if (stage === "normalize") return this.normalizeModel;
    if (stage === "render" || stage === "render_review") return this.renderModel;
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

  async extract(text: string, state: UserState): Promise<{ understanding: TurnUnderstanding | null; proposal: unknown; audit: ModelAudit }> {
    const result = await this.invoke("extract", [
      { role: "system", content: "你只负责从当前用户消息提取导购状态增量、明确的当轮信号和生活偏好观察。只输出 JSON：{updates:[{field,value,quote,status}],signals:[{kind,value,quote,explicit,subject,temporal}],lifestyle:[{kind,value,quote,scope,explicit,subject}]}。quote 必须逐字来自当前消息。情绪只在用户明确表达时标 explicit=true；temporal 只能是 current、historical、unclear。预算低不代表焦虑，短句不代表生气。识别否定、过去经历、替别人咨询。“算了，还是看保湿吧”这类说法是改变选择，不是拒绝；只有明确停止咨询或暂不购买才标记 reject。不要计算价格、推荐商品或推测未说的信息。可用 signal value：worried,frustrated,hesitant,happy,price_objection,reject,correction,hurry,direct_answer,morning_rush,exercise,travel,simple_routine,existing_routine,sensory_discomfort。可用 lifestyle kind：routine_preference,frequent_travel,fragrance_preference,texture_preference,purchase_preference。" },
      { role: "user", content: JSON.stringify({ currentState: effectiveStateView(state), currentMessage: text }, null, 2) },
    ], 8000, false, true);
    const understanding = validateUnderstanding(result.value, text);
    const accepted = understanding !== null;
    return { understanding, proposal: result.value, audit: { ...result.audit, schemaSuccess: accepted, businessAccepted: accepted, used: accepted } };
  }

  async plan(context: AgentContext, timeoutMs: number): Promise<{ proposal: unknown; audit: ModelAudit }> {
    if (timeoutMs < 500) return { proposal: null, audit: this.emptyAudit("planner", "deadline_exhausted") };
    const result = await this.invoke("planner", [
      { role: "system", content: "你只规划下一步，不推荐、不回答、不修改用户事实。每轮只输出一个合法 JSON 对象，字段为 action、arguments、evidenceNeeded、expectedProgress。action 只能是 search_products、compare_products 或 finalize。search_products 的 arguments 只能是 {\"category\":\"cleanser\"} 等已列在 goal.categories 中的品类；compare_products 只能是 {\"skus\":[\"P101\",\"P102\"]} 等两个已通过资格检查的 SKU；finalize 只能是 {}。严格使用 allowedActions 和已观察到的 SKU；购买多个品类时须分别搜索。搜到全部相关候选后通常 finalize，需要对比且已有两个合法候选时才 compare。不得重复无进展动作。" },
      { role: "user", content: JSON.stringify(compilePlannerContext(context)) },
    ], timeoutMs, false, true, 300);
    return { proposal: result.value, audit: result.audit };
  }

  async finalDecision(context: AgentContext, timeoutMs: number): Promise<{ proposal: unknown; audit: ModelAudit }> {
    if (timeoutMs < 500) return { proposal: null, audit: this.emptyAudit("reason", "deadline_exhausted") };
    const result = await this.invoke("reason", [
      { role: "system", content: "你是最终导购取舍裁决器，只能在已通过系统安全、资格和预算门的 productFits 中选至多两个 SKU，或从 requiredMissingFields 中选一个必须追问的字段。不得生成回复，不得修改事实、价格、功效、政策或安全状态。只输出合法 JSON，二选一：{\"kind\":\"recommend\",\"skus\":[\"P101\"],\"evidenceIds\":[\"已有证据ID\"],\"relation\":\"single\"} 或 {\"kind\":\"ask\",\"field\":\"已有字段ID\",\"questionGoal\":\"提问目的\",\"evidenceGap\":\"缺失信息\"}。推荐时 evidenceIds 必须来自选中 ProductFit 的已有证据；缺少关键字段时选 ask。" },
      { role: "user", content: JSON.stringify({ goal: context.goal, userState: compileReasoningContext(context).userState, requiredMissingFields: context.requiredMissingFields, productFits: context.productFits.map((fit) => ({ sku: fit.sku, status: fit.status, matches: fit.matches, tradeoffs: fit.tradeoffs, missing: fit.missing, evidenceIds: fit.evidence.map((item) => item.id) })), comparisons: context.observations.filter((item) => item.tool === "compare_products").map((item) => item.data), versions: context.versions }) },
    ], timeoutMs, true, false, 1400);
    return { proposal: result.value, audit: result.audit };
  }

  async reason(context: AgentContext, deadlineAt = Number.POSITIVE_INFINITY): Promise<{ proposal: unknown; audits: ModelAudit[] }> {
    const reasonBudget = Math.min(24000, deadlineAt - Date.now());
    if (reasonBudget < 500) return { proposal: null, audits: [this.emptyAudit("reason", "deadline_exhausted")] };
    const result = await this.invoke("reason", [
      { role: "system", content: "你是导购决策复核器。只可在 candidateFits 中未排除的 SKU 内排序，或从 allowedQuestionFields 中选择最多两个追问字段。不得修改价格、商品事实、用户已确认状态或规则。最终 content 只输出 JSON：{candidateSkus:string[],questionFields:string[]}。" },
      { role: "user", content: JSON.stringify(compileReasoningContext(context)) },
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
      { role: "system", content: `你是澄初导购的受控表达器，只负责承接、过渡、提问和收尾。事实句由 factBlocks 锁定，你只能在 blockIds 中排列，不能复述、改写或新增价格、SKU、功效、安全和政策事实。免费文本中不要出现数字、货币、SKU、医疗承诺、催单或虚构亲身经历。根据 policy 输出 JSON：{acknowledgement:string,blockIds:string[],questions:[{field:string,text:string}],closing:string,actsUsed:string[]}。questions 字段必须与 selectedQuestionFields 完全一致。\n\n说话要求：\n- ${conversationLanguageRules.join("\n- ")}\n- acknowledgement、question 和 closing 都要短；没有实际作用的客套不要写。\n- 直接问价格或结论时先回答，不强加安慰；赶时间或烦躁时更短、更直接。\n- 只写顾客听得懂的话，不解释内部策略、字段名或模型过程。` },
      { role: "user", content: JSON.stringify({ policy: plan.policy, factBlocks: plan.factBlocks, questionGoals: plan.questionGoals }, null, 2) },
    ], Math.min(6000, timeoutMs), false, true, 600);
    const copy = validateRenderProposal(result.value, plan);
    const accepted = copy !== null;
    return { copy, audit: { ...result.audit, schemaSuccess: result.value !== null, businessAccepted: accepted, used: accepted, ...(result.value !== null && !accepted ? { failureReason: "render_business_validation_failed" } : {}) } };
  }

  async reviewRender(plan: ConversationPlan, copy: RenderedCopy, timeoutMs = 4000): Promise<{ approved: boolean; audit: ModelAudit }> {
    if (timeoutMs < 500) return { approved: false, audit: this.emptyAudit("render_review", "deadline_exhausted") };
    const result = await this.invoke("render_review", [
      { role: "system", content: "你是独立的导购回复审核员。只判断候选回复是否有超出锁定 factBlocks 的赠品、退换、优惠、功效、安全或商品承诺，是否索取未授权的联系方式或地址，是否提出 selectedQuestionFields 之外的问题，是否把未知信息说成已确认。不能依据常识补充品牌政策。只输出 JSON：{\"approved\":boolean,\"reason\":string}。有疑问时 approved=false。" },
      { role: "user", content: JSON.stringify({ allowedFactBlocks: plan.factBlocks, selectedQuestionFields: plan.policy.selectedQuestionFields, questionGoals: plan.questionGoals, candidateReply: copy.reply, candidateQuestions: copy.questions }) },
    ], Math.min(4000, timeoutMs), false, true, 350);
    const approved = Boolean(result.value && typeof result.value === "object" && (result.value as { approved?: unknown }).approved === true);
    return { approved, audit: { ...result.audit, schemaSuccess: result.value !== null, businessAccepted: approved, used: approved, ...(!approved ? { failureReason: result.audit.failureReason ?? "render_review_rejected" } : {}) } };
  }
}
