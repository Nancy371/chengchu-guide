# 澄初 AI 金牌导购

可现场试用的个人护理商品导购 Agent。系统使用品牌手册中的六个 SKU、强制商品安全与资格门禁、确定性算价；Planner 选择受控的搜索和比较路径，Final Decision Reasoner 提议商品取舍或必要追问，本地最终授权后才能回复。Conversation Skills 负责情绪承接、节奏适配和生活场景沟通。

## 本地运行

```bash
pnpm install
pnpm db:generate
pnpm build
pnpm start
```

首次运行前按 [使用说明](docs/USAGE.md) 应用 D1 迁移。未设置 `DEEPSEEK_API_KEY` 时，系统以同一业务规则走本地确定性降级；设置密钥后，抽取与 Planner 调用 DeepSeek Flash 非思考模式，最终裁决调用 DeepSeek V4 Pro 思考模式。

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
