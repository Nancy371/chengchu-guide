# 澄初 AI 金牌导购

可现场试用的个人护理商品导购 Agent。系统使用品牌手册中的六个 SKU、统一商品资格规则和确定性算价；模型只负责状态抽取与复杂冲突提案，不能改写商品事实、预算或安全边界。

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
pnpm lint
pnpm build
```
