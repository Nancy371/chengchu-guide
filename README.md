# 澄初 AI 金牌导购

可现场试用的个人护理商品导购 Agent。系统使用品牌手册中的六个 SKU、统一商品资格规则和确定性算价；模型负责状态与当轮信号抽取、复杂冲突提案和受控表达，不能改写商品事实、预算或安全边界。Conversation Skills 负责情绪承接、节奏适配和生活场景沟通。

## 本地运行

```bash
pnpm install
pnpm db:generate
pnpm build
pnpm start
```

首次运行前按 [使用说明](docs/USAGE.md) 应用 D1 迁移。未设置 `DEEPSEEK_API_KEY` 时，系统以同一业务规则走本地抽取降级，界面仍可完整试用；设置密钥后，抽取与格式修复调用 DeepSeek Flash 非思考模式，复杂冲突调用 DeepSeek V4 Pro 思考模式。

## 文档

- [使用与规则说明](docs/USAGE.md)
- [架构说明](docs/ARCHITECTURE.md)
- [真实自测记录](docs/SELF_TEST.md)
- [视觉系统](DESIGN.md)

## 验证

```bash
pnpm test
pnpm eval:conversation
pnpm lint
pnpm build
```

`pnpm eval:judge` 使用固定的 DeepSeek 盲评配置比较旧式表达与当前 Conversation Policy 表达，需要临时提供 `DEEPSEEK_API_KEY`，结果写入 `evals/latest-model-judge.json`。
