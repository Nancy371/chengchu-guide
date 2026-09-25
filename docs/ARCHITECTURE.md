# 架构说明

每轮请求统一进入 `ConversationRuntime.handleTurn(sessionId, requestId, text)`，由三个职责边界清晰的模块完成。

## ConversationRuntime

负责输入落库、请求幂等、版本控制、模型阶段调度、检查点和条件提交。新输入会先增加 `inputVersion` 并清空当前建议；迟到结果只有在输入版本与状态版本仍匹配时才能保存。

抽取完成后，已验证状态在推理前写入 D1。模型失败时，运行时从最新权威状态重新执行本地规则，不直接恢复旧推荐卡。

## GuideDecision

商品目录、规则函数、候选资格、信息缺口、复杂度路由、排序和算价集中在领域层。`ProductFit` 是普通路径、推理路径和依据面板共享的唯一候选证据。

模型提案只能从未排除候选中选择，并只能提出允许的追问字段。最终提交前重新计算安全、预算和政策规则。

## ResponseComposer

回复由本地模板使用已验证字段生成，不透传模型自由文本。商品卡和依据抽屉都读取同一个 `DecisionResult`，避免顾客回复与解释面板出现两套逻辑。

## 模型调用

- Extractor：`qwen-plus` 非思考模式，8 秒上限，输出带原话引用的状态增量。
- Reasoner：`qwen-plus` 思考模式，仅处理复杂冲突或安全歧义，24 秒上限，默认 2,048 token。
- Normalizer：本地先解析；必要时一次非思考格式修复，6 秒上限。只能修表示形式，不能增加事实或候选。

每轮记录模型是否调用、解析是否成功、Schema 是否合格、业务是否接受、结果是否使用、耗时和失败原因。

## 数据与接口

- `POST /api/session`：创建隔离会话。
- `GET /api/session`：恢复状态和已完成轮次。
- `DELETE /api/session`：清除会话。
- `POST /api/chat`：提交 `{ requestId, text }`，返回结构化决策。
- WebMCP `ask_chengchu_guide`：复用同一 `/api/chat` 可信路径完成一轮咨询。

D1 使用 `sessions` 与 `requests` 两张表。`sessionId + requestId` 唯一约束保证重试不重复推进；会话限流为每分钟 6 次、每天 50 次，全站每天 500 次。

