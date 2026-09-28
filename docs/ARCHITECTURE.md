# 架构说明

每轮请求统一进入 `ConversationRuntime.handleTurn(sessionId, requestId, text, userId)`。当前决策链是 `Verified State → Planner → 工具与观察 → Final Decision Reasoner → Final Authorization → Renderer`。明确当前不适会在商品候选生成之前转入安全回应。

## ConversationRuntime

负责输入落库、请求幂等、版本控制、模型阶段调度、检查点和条件提交。新输入会先增加 `inputVersion` 并清空当前建议；迟到结果只有在输入版本与状态版本仍匹配时才能保存。

抽取完成后，已验证状态在规划前写入 D1。模型失败时，运行时从最新权威状态重新执行本地规则；确定性结果也必须经过同一个最终授权入口，不直接恢复旧推荐卡。

`verifiedState.update` 是正常请求、超时重放和异常回退共用的状态入口。模型字段须有当轮逐字引文，且本地语义识别须支持同一字段值；被拒提案与抽取审计分开记录。刺痛、疼痛、皮肤破损和其他不适各自保留原话及轮次，`currentDiscomfort` 只由这些事实及旧会话未解除风险计算。明确改口会把旧值移入历史，品类与 SKU 冲突时旧 SKU 失效。

## Planner、商品门禁与最终裁决

Planner 每步只可搜索商品、比较两个已合格候选、提出一个必要追问，或申请 `finalize`，最多五步。动作由 `ActionPolicy` 检查范围、参数、重复和证据前置条件；无进展、超时或模型失败则进入确定性回退。Planner 不直接推荐或回复。

搜索返回的原始 SKU 强制经过安全、资格、硬约束和预算检查，才形成 `ProductFit`。`check_safety` 与 `check_eligibility` 不由 Planner 选择是否调用。商品目录、规则函数和确定性算价仍集中在领域层；比较工具只组织已核实差异。

必要缺口只保留会改变安全、候选资格或同类合格商品取舍的字段。低风险同一字段在同一目标下最多问四轮；插入问价不计数，目标或候选变化后重算。四轮仍不明确时，两款合格商品只作事实比较，单款合格商品可直接推荐。安全含糊不受四轮上限约束；用户当轮明确拒答时停止追问，但以后再次选购仍需核实。事实比较和所有降级提案仍经过最终授权。

Final Decision Reasoner 只可从合法 `ProductFit` 中选最多两个 SKU 及已有证据 ID，或从当前必要缺口中选一个问题字段。`authorizeFinalDecision()` 重新核对 SKU、证据、预算、价格关系、安全和输入／状态／知识／记忆版本。模型提案和获准结果分别保留。规则直达和回退也必须经过此入口。依据抽屉展示规划、工具、提案、授权及降级摘要。

## Conversation Skills 与 ResponseComposer

决策完成后，Skill Router 选择一个主任务 Skill，并最多组合一个情绪或节奏行为和一个生活场景行为。结构化 `ConversationPolicy` 明确是否承接、问题额度、语气、表达长度、可用记忆和不可改写事实块。

Renderer 使用 `deepseek-flash` 非思考模式，只能排列事实块并生成承接、过渡和获准问题。自由文本出现价格、SKU、额外承诺、多余问题或禁用表达时会被拒绝，并回退本地模板。安全停推和明确拒绝直接使用确定性模板。

## 模型调用

- Extractor：`deepseek-flash` 非思考模式，8 秒上限，输出带原话引用的状态增量。
- Planner：`deepseek-flash` 非思考模式，单步不超过 2.5 秒，只输出结构化动作。
- Final Decision Reasoner：`deepseek-v4-pro` 思考模式，在 Planner 完成证据收集后提出最终取舍或必要追问；调用预算最多 16 秒，输出仅供本地授权。
- Renderer：`deepseek-flash` 非思考模式，6 秒与 600 token 上限；只进行受控表层表达。

模型通过 DeepSeek 的 OpenAI 兼容 `/chat/completions` 接口调用。每次请求都显式设置思考模式，避免服务端默认值变化影响路由职责；`reasoning_content` 不写入事实库，也不在顾客界面展示。

每轮记录模型是否调用、解析是否成功、Schema 是否合格、业务是否接受、结果是否使用、耗时和失败原因。

## 数据与接口

- `POST /api/session`：创建隔离会话。
- `GET /api/session`：恢复状态和已完成轮次。
- `DELETE /api/session`：清除会话。
- `POST /api/chat`：提交 `{ requestId, text }`，返回结构化决策。
- `GET/PUT/PATCH/DELETE /api/preferences`：读取、授权、修改和删除跨设备习惯记忆；写操作要求 ChatGPT 登录。
- WebMCP `ask_chengchu_guide`：复用同一 `/api/chat` 可信路径完成一轮咨询。

D1 使用 `sessions`、`requests`、`memory_settings` 与 `habit_memories`。会话按服务端验证的用户 ID 隔离；匿名、登录、退出或切换账号后不会复用不属于当前身份的会话。`sessionId + requestId` 唯一约束保证重试不重复推进；会话限流为每分钟 6 次、每天 50 次，全站每天 500 次。

请求登记、输入版本分配和请求版本回填使用 D1 事务批处理。`applied_input_version` 记录已经写入状态的最后一条输入；后发请求依次等待前驱状态。前驱超时后从请求表保存的原文做本地提取并推进版本，迟到的旧回复只返回失效提示。自由表达先过本地越权校验，再由独立模型语义复核；复核不可用或不通过时使用本地模板。

习惯记忆写入同时绑定输入版本、状态版本和授权设置版本。关闭、删除或清空会提升设置版本，已在途的旧请求无法把被删除内容写回。到期项读取时立即过滤并删除。
