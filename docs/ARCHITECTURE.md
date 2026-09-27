# 架构说明

每轮请求统一进入 `ConversationRuntime.handleTurn(sessionId, requestId, text, userId)`，由三个职责边界清晰的模块完成。

## ConversationRuntime

负责输入落库、请求幂等、版本控制、模型阶段调度、检查点和条件提交。新输入会先增加 `inputVersion` 并清空当前建议；迟到结果只有在输入版本与状态版本仍匹配时才能保存。

抽取完成后，已验证状态在推理前写入 D1。模型失败时，运行时从最新权威状态重新执行本地规则，不直接恢复旧推荐卡。

## GuideDecision

商品目录、规则函数、候选资格、信息缺口、复杂度路由、排序和算价集中在领域层。`ProductFit` 是普通路径、推理路径和依据面板共享的唯一候选证据。

模型提案只能从未排除候选中选择，并只能提出允许的追问字段。最终提交前重新计算安全、预算和政策规则。

## Conversation Skills 与 ResponseComposer

决策完成后，Skill Router 选择一个主任务 Skill，并最多组合一个情绪或节奏行为和一个生活场景行为。结构化 `ConversationPolicy` 明确是否承接、问题额度、语气、表达长度、可用记忆和不可改写事实块。

Renderer 使用 `deepseek-flash` 非思考模式，只能排列事实块并生成承接、过渡和获准问题。自由文本出现价格、SKU、额外承诺、多余问题或禁用表达时会被拒绝，并回退本地模板。安全停推和明确拒绝直接使用确定性模板。

## 模型调用

- Extractor：`deepseek-flash` 非思考模式，8 秒上限，输出带原话引用的状态增量。
- Reasoner：`deepseek-v4-pro` 思考模式，仅处理复杂冲突或安全歧义，24 秒上限，默认 2,048 token。
- Normalizer：本地先解析；必要时调用一次 `deepseek-flash` 非思考模式完成格式修复，6 秒上限。只能修表示形式，不能增加事实或候选。
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

习惯记忆写入同时绑定输入版本、状态版本和授权设置版本。关闭、删除或清空会提升设置版本，已在途的旧请求无法把被删除内容写回。到期项读取时立即过滤并删除。
