# 使用与规则说明

## 支持的输入

首版接收中文文字咨询，支持自然表达需求、预算、肤质、核心诉求、敏感倾向、当前不适、情绪、香味与质地偏好、果酸经验、已有产品、晨间/运动/旅行场景、渠道偏好及门店政策问题。单次输入最多 600 字。

首版不接收图片、PDF 或表格上传，不处理支付、库存和真实客服转接。题目 PDF 已在开发阶段整理为受控的六 SKU 商品目录。

## 规则如何使用

1. 顾客原话先形成带来源和轮次的状态增量。
2. Schema 与语义校验拒绝没有原话依据的模型字段。
3. 本地规则为每个 SKU 生成 `ProductFit`，区分可推荐、待补信息和已排除。
4. 普通场景直接决策；只有偏好冲突或安全语义歧义进入思考模型。
5. 最终回复只能使用商品目录和规则已经允许的事实，金额由本地整数工具计算。
6. 赠品、促销、线上同价、退换和授权资料缺失时，只把对应政策标为待确认，不影响已核实价格。
7. 决策完成后由 Conversation Skill Router 选择承接、节奏和生活场景行为；表达模型只能使用已批准事实块，校验失败时回退本地模板。

当前不适优先于销售动作；P201 果酸产品要求有相关经验、皮肤状态稳定且不属于敏感倾向。香味敏感只降低带香产品优先级，明确“必须无香”才作为硬约束。

## 输出内容

顾客界面展示自然回复、必要追问、推荐商品、单价、组合总价、理由和取舍。点击“推荐依据”可查看：

- 当前有效的用户事实及原话；
- 路由类型与触发原因；
- 商品事实与政策未知项；
- 候选资格；
- 输入版本、状态版本和知识版本；
- 模型是否调用、是否解析、是否被业务接受及是否最终采用；
- 限制与人工确认事项。
- 本轮主 Skill、组合行为、明确的承接原话、实际使用的偏好和表达来源。

## 跨设备偏好

匿名访问支持完整导购。点击“我的偏好”可使用 ChatGPT 登录；登录与记忆授权相互独立，记忆默认关闭。开启后只保存随后明确表达的精简步骤、经常出差、香味、质地和购买方式偏好，有效期 90 天。

情绪、当前不适、病史、临时预算、精确行程和聊天原文不会进入长期记忆。用户可以查看、修改、单项删除、清空或“关闭并清除记忆”。当前输入始终优先于旧偏好。

## 服务配置

- `DEEPSEEK_API_KEY`：DeepSeek API 密钥，仅存服务端。
- `DEEPSEEK_BASE_URL`：可选，默认 `https://api.deepseek.com`。
- `DEEPSEEK_EXTRACT_MODEL`：可选，默认 `deepseek-flash`，关闭思考。
- `DEEPSEEK_REASON_MODEL`：可选，默认 `deepseek-v4-pro`，开启思考。
- `DEEPSEEK_NORMALIZE_MODEL`：可选，默认 `deepseek-flash`，关闭思考。
- `DEEPSEEK_RENDER_MODEL`：可选，默认 `deepseek-flash`，关闭思考。
- `MODEL_API_KEY`：兼容的密钥变量名。

模型不可用、超时或格式错误时，本地抽取与业务规则继续工作；依据面板会把该阶段记录为降级。会话保留 24 小时，可主动清除。

## 本地 D1

生成迁移后，先构建，再执行：

```bash
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute site-creator-d1 --local --config dist/server/wrangler.json --persist-to .wrangler/state --file dist/.openai/drizzle/0000_same_retro_girl.sql
node --import ./scripts/sites-env.mjs ./node_modules/wrangler/bin/wrangler.js d1 execute site-creator-d1 --local --config dist/server/wrangler.json --persist-to .wrangler/state --file dist/.openai/drizzle/0001_gorgeous_surge.sql
```
