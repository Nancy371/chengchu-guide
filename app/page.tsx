"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ClipboardCheck, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import type { DecisionResult, FactValue, SourcedFact } from "@/lib/guide/types";

type HistoryItem = {
  requestId: string;
  text: string;
  status: string;
  result: DecisionResult | null;
};

type SessionPayload = {
  session: { result: DecisionResult | null } | null;
  history: HistoryItem[];
  error?: string;
};

type WebMcpResult = { content: Array<{ type: "text"; text: string }> };
type ModelContextTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: { text?: string }) => Promise<WebMcpResult>;
};

declare global {
  interface Document {
    modelContext?: {
      registerTool: (tool: ModelContextTool) => void;
      unregisterTool?: (name: string) => void;
    };
  }
}

const starters = [
  "想买洗面奶",
  "预算 400，想配洁面和保湿",
  "我想试果酸改善粗糙",
  "P101 网上更便宜，门店能同价吗？",
];

const fieldLabels: Record<string, string> = {
  intent: "本轮意图",
  targetSku: "指定商品",
  categories: "所需品类",
  budget: "预算",
  budgetScope: "预算范围",
  skinType: "肤质",
  sensitiveTendency: "敏感倾向",
  currentDiscomfort: "当前不适",
  fragrancePreference: "香味偏好",
  acidExperience: "果酸经验",
  existingProducts: "已有产品",
  travelNeed: "旅行需求",
  coreConcern: "核心诉求",
  channelPreference: "渠道偏好",
  claimedOnlinePrice: "用户提到的线上价",
  policyTopics: "待确认政策",
};

const valueLabels: Record<string, string> = {
  dry: "偏干",
  oily: "偏油",
  cleanser: "洁面",
  moisturizer: "保湿",
  serum: "精华",
  travel: "旅行分装",
  fragrance_sensitive: "对香味敏感",
  must_be_fragrance_free: "必须无香",
  accepts_fragrance: "可接受香味",
  recommend: "商品推荐",
  clarify: "需求确认",
  price: "价格查询",
  policy: "政策查询",
  true: "是",
  false: "否",
  unclear: "待确认",
};

function displayValue(value: FactValue, field?: string) {
  if (field === "budget" || field === "claimedOnlinePrice") return `¥${Number(value) / 100}`;
  if (Array.isArray(value)) return value.map((item) => valueLabels[item] ?? item).join("、");
  return valueLabels[String(value)] ?? String(value);
}

function RecommendationRows({ result }: { result: DecisionResult }) {
  if (!result.recommendations.length) return null;
  return (
    <div className="recommendation-list" aria-label="推荐商品">
      {result.recommendations.map((item, index) => (
        <article className="product-row" key={item.sku}>
          <div className="product-index">{String(index + 1).padStart(2, "0")}</div>
          <div className="product-copy">
            <div className="product-heading">
              <span className="sku">{item.sku}</span>
              <h3>{item.name}</h3>
            </div>
            <p>{item.reasons[0] ?? "已通过当前规则校验"}</p>
            {item.tradeoffs[0] ? <p className="tradeoff">注意：{item.tradeoffs[0]}</p> : null}
          </div>
          <strong>¥{item.priceFen / 100}</strong>
        </article>
      ))}
      {result.totalFen && result.recommendations.length > 1 ? (
        <div className="bundle-total"><span>组合总价</span><strong>¥{result.totalFen / 100}</strong></div>
      ) : null}
    </div>
  );
}

function EvidenceDrawer({ result }: { result: DecisionResult | null }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button className="evidence-button" variant="outline" disabled={!result}>
          <ClipboardCheck aria-hidden="true" /> 推荐依据
        </Button>
      </SheetTrigger>
      <SheetContent className="evidence-sheet sm:max-w-[520px]">
        <SheetHeader className="evidence-header">
          <SheetTitle>本轮推荐依据</SheetTitle>
          <SheetDescription>只展示已验证状态、商品手册事实和本地规则结果。</SheetDescription>
        </SheetHeader>
        {result ? (
          <div className="evidence-body">
            <div className="route-card">
              <span>{result.route === "reasoning" ? "复杂场景" : result.route === "safety" ? "安全响应" : result.route === "degraded" ? "降级决策" : "直接决策"}</span>
              <strong>{result.routeReason}</strong>
            </div>
            <Accordion defaultValue={["state", "evidence"]} type="multiple">
              <AccordionItem value="state">
                <AccordionTrigger>已确认信息</AccordionTrigger>
                <AccordionContent>
                  <div className="fact-list">
                    {Object.entries(result.state.facts).length ? Object.entries(result.state.facts).map(([field, raw]) => {
                      const item = raw as SourcedFact;
                      return (
                        <div className="fact-row" key={field}>
                          <span>{fieldLabels[field] ?? field}</span>
                          <strong>{displayValue(item.value, field)}</strong>
                          <q>{item.quote}</q>
                        </div>
                      );
                    }) : <p className="muted">还没有已确认信息。</p>}
                  </div>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="evidence">
                <AccordionTrigger>事实与规则</AccordionTrigger>
                <AccordionContent>
                  <div className="evidence-list">
                    {result.evidence.length ? result.evidence.map((item) => (
                      <div className="evidence-row" key={item.id}>
                        <span className={`evidence-status ${item.status}`}>{item.status === "supported" ? "已核实" : item.status === "unknown" ? "待确认" : "受限"}</span>
                        <div><strong>{item.label}</strong><p>{item.detail}</p><small>{item.source}</small></div>
                      </div>
                    )) : <p className="muted">本轮没有需要展开的商品事实。</p>}
                  </div>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="candidates">
                <AccordionTrigger>候选资格</AccordionTrigger>
                <AccordionContent>
                  <div className="fit-grid">
                    {result.productFits.map((fit) => (
                      <div className="fit-row" key={fit.sku}>
                        <strong>{fit.sku}</strong>
                        <span data-status={fit.status}>{fit.status === "eligible" ? "可推荐" : fit.status === "needs_information" ? "待补信息" : "已排除"}</span>
                        <p>{fit.blockers[0] ?? fit.missing[0] ?? fit.matches[0] ?? "通过基础商品事实检查"}</p>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="audit">
                <AccordionTrigger>运行校验</AccordionTrigger>
                <AccordionContent>
                  <div className="audit-summary">
                    <p>输入版本 <strong>{result.versions.input}</strong> · 状态版本 <strong>{result.versions.state}</strong></p>
                    <p>知识版本 <strong>{result.versions.knowledge}</strong></p>
                    {result.audits.map((audit, index) => (
                      <p key={`${audit.stage}-${index}`}>{audit.stage} · {audit.modelInvoked ? `${audit.model} / ${audit.used ? "已采用" : "未采用"}` : "本地降级"} · {audit.latencyMs}ms</p>
                    ))}
                    {result.limitations.map((item) => <p className="limitation" key={item}>限制：{item}</p>)}
                  </div>
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export default function Home() {
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [latestResult, setLatestResult] = useState<DecisionResult | null>(null);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [serviceError, setServiceError] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);
  const submitRef = useRef<(text: string) => Promise<DecisionResult | null>>(async () => null);

  const facts = useMemo(() => Object.entries(latestResult?.state.facts ?? {}).slice(0, 6), [latestResult]);

  async function ensureSession() {
    const current = await fetch("/api/session", { cache: "no-store" });
    let payload = await current.json() as SessionPayload;
    if (!current.ok) throw new Error(payload.error ?? "暂时无法连接会话服务。");
    if (!payload.session) {
      const created = await fetch("/api/session", { method: "POST" });
      payload = await created.json() as SessionPayload;
      if (!created.ok) throw new Error(payload.error ?? "暂时无法创建会话。");
    }
    setHistory(payload.history ?? []);
    setLatestResult(payload.session?.result ?? payload.history?.at(-1)?.result ?? null);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void ensureSession().catch((error: Error) => setServiceError(error.message)).finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [history, sending]);

  async function submit(text = input): Promise<DecisionResult | null> {
    const clean = text.trim();
    if (!clean || sending) return null;
    const requestId = crypto.randomUUID();
    setSending(true);
    setServiceError("");
    setInput("");
    setHistory((items) => [...items, { requestId, text: clean, status: "processing", result: null }]);
    try {
      const response = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ requestId, text: clean }),
      });
      const payload = await response.json() as { result?: DecisionResult; error?: string };
      if (!response.ok || !payload.result) throw new Error(payload.error ?? "本轮没有生成有效结果。");
      setLatestResult(payload.result);
      setHistory((items) => items.map((item) => item.requestId === requestId ? { ...item, status: "complete", result: payload.result! } : item));
      return payload.result;
    } catch (error) {
      setHistory((items) => items.filter((item) => item.requestId !== requestId));
      setServiceError(error instanceof Error ? error.message : "服务暂时不可用。");
      return null;
    } finally {
      setSending(false);
    }
  }

  async function resetSession() {
    setLoading(true);
    await fetch("/api/session", { method: "DELETE" }).catch(() => undefined);
    setHistory([]);
    setLatestResult(null);
    setServiceError("");
    try { await ensureSession(); } catch (error) { setServiceError(error instanceof Error ? error.message : "无法新建会话。"); }
    setLoading(false);
  }

  useEffect(() => {
    submitRef.current = submit;
  });
  useEffect(() => {
    if (!document.modelContext?.registerTool) return;
    const name = "ask_chengchu_guide";
    document.modelContext.registerTool({
      name,
      description: "向澄初 AI 导购提交一条中文商品咨询，并返回依据品牌资料和业务规则校验后的本轮决策。",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string", description: "顾客本轮要补充的需求、预算、肤质、顾虑或政策问题。", minLength: 1, maxLength: 600 } },
        required: ["text"],
        additionalProperties: false,
      },
      execute: async ({ text }) => {
        const result = await submitRef.current(text ?? "");
        return {
          content: [{
            type: "text",
            text: result ? JSON.stringify({ action: result.action, reply: result.reply, recommendations: result.recommendations, totalFen: result.totalFen, limitations: result.limitations, versions: result.versions }) : JSON.stringify({ error: "本轮未能生成有效结果" }),
          }],
        };
      },
    });
    return () => document.modelContext?.unregisterTool?.(name);
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="#main-conversation" aria-label="澄初 AI 金牌导购首页">
          <span className="brand-mark" aria-hidden="true">澄</span>
          <span><strong>澄初个人护理</strong><small>AI 金牌导购</small></span>
        </a>
        <div className="header-actions">
          <span className="service-state"><i /> 资料规则已加载</span>
          <Button variant="ghost" className="reset-button" onClick={resetSession} disabled={loading || sending}><RotateCcw /> 新咨询</Button>
          <EvidenceDrawer result={latestResult} />
        </div>
      </header>

      <div className="workspace">
        <aside className="case-sheet" aria-label="本轮咨询单">
          <h2>本轮咨询单</h2>
          <p className="aside-lead">只记录您明确说过、且仍然有效的信息。</p>
          <div className="fact-stack">
            {facts.length ? facts.map(([field, raw]) => {
              const item = raw as SourcedFact;
              return <div className="brief-fact" key={field}><span>{fieldLabels[field] ?? field}</span><strong>{displayValue(item.value, field)}</strong></div>;
            }) : <div className="empty-brief"><Sparkles aria-hidden="true" /><p>说说想买什么，我会从最影响选择的信息开始问。</p></div>}
          </div>
          <div className="privacy-note"><ShieldCheck aria-hidden="true" /><p>会话保留 24 小时。您可以随时点击“新咨询”清除。</p></div>
        </aside>

        <section className="conversation" id="main-conversation" aria-busy={sending || loading}>
          <div className="conversation-header">
            <div><h1>先了解一点，再给您合适的建议</h1></div>
            <span>{history.length ? `第 ${history.length} 轮` : "新咨询"}</span>
          </div>

          <div className="messages" aria-live="polite">
            {!history.length && !loading ? (
              <div className="welcome-block">
                <p>您好，我是澄初 AI 导购。您可以直接说需求、预算或顾虑；我通常一次只追问一个关键问题。</p>
                <div className="starter-grid">
                  {starters.map((starter) => <button key={starter} onClick={() => submit(starter)}>{starter}<ArrowUp aria-hidden="true" /></button>)}
                </div>
              </div>
            ) : null}
            {loading ? <div className="loading-line">正在恢复咨询记录…</div> : null}
            {history.map((item) => (
              <div className="turn" key={item.requestId}>
                <div className="user-message"><span>您</span><p>{item.text}</p></div>
                {item.result ? (
                  <div className="assistant-message">
                    <div className="advisor-avatar" aria-hidden="true">澄</div>
                    <div className="assistant-content">
                      <p>{item.result.reply}</p>
                      <RecommendationRows result={item.result} />
                      <button className="inline-evidence" onClick={() => setLatestResult(item.result)}>已按 {item.result.evidence.length} 条事实与规则核对 · 查看顶部推荐依据</button>
                    </div>
                  </div>
                ) : <div className="assistant-message"><div className="advisor-avatar">澄</div><div className="thinking-line"><i /><i /><i /><span>正在核对资料与规则</span></div></div>}
              </div>
            ))}
            {serviceError ? <div className="service-error" role="alert"><strong>暂时没能完成</strong><p>{serviceError} 已确认的信息仍然保留，您可以稍后重试。</p></div> : null}
            <div ref={bottomRef} />
          </div>

          <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            <label htmlFor="guide-input">继续补充需求</label>
            <div className="composer-row">
              <Textarea id="guide-input" value={input} maxLength={600} disabled={sending || loading} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="例如：我偏干，预算 450 元，可以接受无香…" />
              <Button type="submit" size="icon" aria-label="发送" disabled={!input.trim() || sending || loading}><ArrowUp /></Button>
            </div>
            <div className="composer-meta"><span>Enter 发送 · Shift + Enter 换行</span><span>{input.length}/600</span></div>
          </form>
        </section>
      </div>
    </main>
  );
}
