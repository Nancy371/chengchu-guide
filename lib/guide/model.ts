import { env } from "cloudflare:workers";
import { effectiveStateView, validateUnderstanding } from "./state";
import { compileReasoningContext } from "./agent-context";
import { compilePlannerContext } from "./planner";
import { conversationLanguageRules, validateRenderProposal, type ConversationPlan, type RenderedCopy } from "./conversation";
import type { AgentContext, ModelAudit, StateField, TurnUnderstanding, UserState } from "./types";

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

  async extract(text: string, state: UserState, pendingQuestion?: StateField): Promise<{ understanding: TurnUnderstanding | null; proposal: unknown; audit: ModelAudit }> {
    const result = await this.invoke("extract", [
      { role: "system", content: "你只负责从当前用户消息提取导购状态增量、明确信号、生活偏好和本轮购买动作。只输出 JSON：{updates:[{field,value,quote,status}],signals:[{kind,value,quote,explicit,subject,temporal}],lifestyle:[{kind,value,quote,scope,explicit,subject}],purchaseAction:{kind,quote},skuMentions:[{sku,quote,role}]}。purchaseAction.kind 只能是 answer_question、switch_goal、accept_current、reject_current、request_alternative、ask_why_not、compare_with_previous、ask_about_product、select_product、price_interruption、policy_interruption、decline_answer、end、continue。skuMentions.role 只能是 target、comparison、inquiry、rejection、selection。SKU 出现不等于用户想买；询问价格、追问落选原因和比较时不得写 targetSku。所有 quote 必须逐字来自当前消息。有上一轮待答问题时，‘可以、还行’优先是问题回答，不是接受商品。不能把问价插话误判为换目标，也不能把‘还有别的吗’漏成普通继续。预算问题下回答‘还没想好，先看看’表示暂缓预算，可标 decline_answer，但不等于停止购买。情绪只在用户明确表达时标 explicit=true；temporal 只能是 current、historical、unclear。预算低不代表焦虑，短句不代表生气。识别否定、过去经历、替别人咨询。明确说喜欢桂花香、木质香等，可归纳 fragrancePreference=accepts_fragrance，并把逐字出现的具体香型写入 fragranceNote；不能推断品牌商品有该香型。对香味或质地回答‘都可以、无所谓’可写 no_preference，但不写入 lifestyle。用户明确让导购帮忙定一款时可写 delegateChoice=true。若有上一轮提问而回答含糊，可输出 communication/answer_ambiguous；不能把‘还可以’写成不敏感或皮肤稳定。只有明确停止咨询或暂不购买才标记 reject。不要计算价格、推荐商品或推测未说的信息。可用 signal value：worried,frustrated,hesitant,happy,price_objection,reject,correction,hurry,direct_answer,answer_ambiguous,morning_rush,exercise,travel,simple_routine,existing_routine,sensory_discomfort。可用 lifestyle kind：routine_preference,frequent_travel,fragrance_preference,texture_preference,purchase_preference。" },
      { role: "user", content: JSON.stringify({ currentState: effectiveStateView(state), pendingQuestion, currentMessage: text }, null, 2) },
    ], 8000, false, true);
    const understanding = validateUnderstanding(result.value, text, pendingQuestion);
    const accepted = understanding !== null;
    return { understanding, proposal: result.value, audit: { ...result.audit, schemaSuccess: accepted, businessAccepted: accepted, used: accepted } };
  }

  async plan(context: AgentContext, timeoutMs: number): Promise<{ proposal: unknown; audit: ModelAudit }> {
    if (timeoutMs < 500) return { proposal: null, audit: this.emptyAudit("planner", "deadline_exhausted") };
    const result = await this.invoke("planner", [
      { role: "system", content: "你只规划下一步，不推荐、不回答、不修改用户事实。每步只输出一个合法 JSON 对象，字段为 action、arguments、evidenceNeeded、expectedProgress。action 只能是 allowedActions 中的 search_products、compare_products、ask_user 或 finalize。search_products 的 arguments 是已列在 goal.categories 中的 {\"category\":\"cleanser\"}；compare_products 的 arguments 是两个已通过资格检查的 SKU；ask_user 的 arguments 只能是 {\"field\":\"requiredMissingFields 中的一个字段\"}；finalize 的 arguments 是 {}。购买多个品类时须分别搜索。只要还有必要缺口，就选 ask_user，不能 finalize；搜齐候选且没有缺口后才 finalize。不得重复无进展动作。" },
      { role: "user", content: JSON.stringify(compilePlannerContext(context)) },
    ], timeoutMs, false, true, 300);
    return { proposal: result.value, audit: result.audit };
  }

  async finalDecision(context: AgentContext, timeoutMs: number): Promise<{ proposal: unknown; audit: ModelAudit }> {
    if (timeoutMs < 500) return { proposal: null, audit: this.emptyAudit("reason", "deadline_exhausted") };
    const result = await this.invoke("reason", [
      { role: "system", content: "你是最终导购取舍裁决器。Planner 已完成必要澄清，你只从已通过系统安全、资格和预算门的 productFits 中选至多两个 SKU。不得生成回复，不得修改事实、价格、功效、政策或安全状态。只输出合法 JSON：{\"kind\":\"recommend\",\"skus\":[\"P101\"],\"evidenceIds\":[\"已有证据ID\"],\"relation\":\"single\"}。evidenceIds 必须来自选中 ProductFit 的已有证据。" },
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
      { role: "system", content: `你是澄初导购的受控表达器，负责承接、过渡、提问和收尾，并把 locked=false 的事实块真正改写成自然口语。blockIds 必须保持原顺序，factBlocks 必须逐块覆盖每个 id 并输出改写后的 text。每个块有 spec.locked：locked=true 时 text 必须逐字等于给定 text；locked=false 时必须改写——重新组织句子、换掉书面连接词，让它像当面推荐，不要照抄给定 text 原句。改写时的硬约束：spec.requiredLiterals（SKU、¥价格、浓度等）必须原样出现在 text 里；spec.requiredTerms（功效关键项）必须用等价同义表达保留，可换词但不许遗漏、不许把含义说反（如 无香 可写成 没什么香味/不含香精，但不能写成 带香/有香味）。不得新增价格、功效、安全、政策或赠品承诺。acknowledgement 和 closing 里不要出现数字、货币或 SKU；只有 turnContext.confirmedAnswer 里已核实的预算数字可以出现在 acknowledgement。根据 policy 输出 JSON：{acknowledgement:string,blockIds:string[],factBlocks:[{id:string,text:string}],questions:[{field:string,text:string}],closing:string,actsUsed:string[]}。questions 字段必须与 selectedQuestionFields 完全一致。\n\n改写示例：给定「我会先看 P101 云感氨基酸舒润洁面乳（¥169）：它是无香、低泡的一支，洗后容易冲净」，可改写为「先看这款 P101 云感氨基酸舒润洁面乳（¥169），没什么香味、泡沫也少，洗后容易冲净」——P101、¥169 原样保留，无香≈没什么香味、低泡≈泡沫也少。\n\n说话要求：\n- ${conversationLanguageRules.join("\n- ")}\n- locked=false 的事实块务必换一种说法，别用给定 text 原句；requiredLiterals 原样保留，requiredTerms 用等价同义表达保留。\n- 有 turnContext.actionAcknowledgement 时，只表达对应的接受、否定、解释或比较动作，不再重复事实块里已经写清的商品特点。\n- 用户否定当前商品时，只承认该商品已排除；在没有新 SKU 时不得说‘换一支’‘另一款’或‘新推荐’。\n- 先用一句话承接 turnContext.confirmedAnswer；有 previousQuestion 时，要让人听出刚才的回答已经接住了。\n- 下一题只问 questionGoals 里的一个目标；questionGoals 里的 fallback 只是兜底参考，要像当面聊天那样用自己的话自然地问，不要照抄 fallback，也不要先解释一遍再重复问。\n- 用户对问题说‘不确定/说不准’时，acknowledgement 先温和接住‘不确定也正常’，不要催；factBlocks 里的 hint 块要像科普一样用自己的话讲出来（保留关键点、别说反），再问一个更具体、更容易观察的问题。\n- clarify 时 closing 必须为空；普通聊天可以自然用一个‘好’‘嗯’‘呢’‘呀’或‘吧’，不要连续堆叠，也不要固定每次都用同一句。\n- 直接问价格或结论时先回答；赶时间或烦躁时更短、更直接；不适场景温和但不要绕。\n- 只写顾客听得懂的话，不解释内部策略、字段名或模型过程。` },
      { role: "user", content: JSON.stringify({ policy: plan.policy, factBlocks: plan.factBlocks, questionGoals: plan.questionGoals, turnContext: plan.turnContext }, null, 2) },
    ], Math.min(6000, timeoutMs), false, true, 900);
    const copy = validateRenderProposal(result.value, plan);
    const accepted = copy !== null;
    return { copy, audit: { ...result.audit, schemaSuccess: result.value !== null, businessAccepted: accepted, used: accepted, ...(result.value !== null && !accepted ? { failureReason: "render_business_validation_failed" } : {}) } };
  }

  async reviewRender(plan: ConversationPlan, copy: RenderedCopy, timeoutMs = 4000): Promise<{ approved: boolean; audit: ModelAudit }> {
    if (timeoutMs < 500) return { approved: false, audit: this.emptyAudit("render_review", "deadline_exhausted") };
    const result = await this.invoke("render_review", [
      { role: "system", content: "你是独立的导购回复事实审核员。只核对候选回复是否把事实写错或越权：价格、SKU、浓度必须与 factSpecs 的 requiredLiterals 逐字一致；功效关键项 requiredTerms 必须在候选回复里有等价表达，允许同义改写（无香≈没什么香味/不含香精/没有香味，低泡≈泡沫少/起泡少，清洁感较强≈清洁力较强，清爽≈轻薄不黏，淡香≈香味很淡），但不得遗漏、不得把含义说反（无香 被写成 带香/有香味、低泡 被写成 泡沫丰富/泡沫多、清爽 被写成 厚重/黏腻 即拒绝）；是否新增赠品、退换、优惠、功效、安全或商品承诺；是否把未知信息说成已确认；是否把用户已确认的预算、肤质、香味等状态说错；是否在 SKU 没变时声称‘换一支’‘另一款’或‘新推荐’。纯语气、承接与事实块重复或生硬不构成拒绝理由。只输出 JSON：{\"approved\":boolean,\"reason\":string}。只有事实错误或越权才 approved=false。" },
      { role: "user", content: JSON.stringify({ factSpecs: plan.factBlocks.map((block) => ({ id: block.id, groundTruth: block.text, ...block.spec })), selectedQuestionFields: plan.policy.selectedQuestionFields, questionGoals: plan.questionGoals, turnContext: plan.turnContext, candidateReply: copy.reply, candidateQuestions: copy.questions }) },
    ], Math.min(4000, timeoutMs), false, true, 350);
    const approved = Boolean(result.value && typeof result.value === "object" && (result.value as { approved?: unknown }).approved === true);
    return { approved, audit: { ...result.audit, schemaSuccess: result.value !== null, businessAccepted: approved, used: approved, ...(!approved ? { failureReason: result.audit.failureReason ?? "render_review_rejected" } : {}) } };
  }
}
