"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowUp, ClipboardCheck, RotateCcw, ShieldCheck, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { PreferencesDrawer } from "@/components/preferences-drawer";
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
  "想找一支洗完不紧绷的洁面",
  "早上赶时间，想把护理步骤减一减",
  "想试试果酸，但有点担心刺激",
  "P101 网上更便宜，想比一比",
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
  useOccasions: "使用场景",
  texturePreference: "质地偏好",
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
  morning_rush: "早晨赶时间",
  exercise: "运动后",
  simple_routine: "希望步骤简单",
  lightweight: "偏好轻薄、不黏",
  simple: "希望步骤简单",
  single_item: "倾向单品购买",
  avoid_duplicate: "避免重复购买",
};

const skillLabels: Record<string, string> = {
  clarification: "温和追问",
  recommendation: "推荐与取舍",
  budget_conflict: "预算取舍",
  price_objection: "价格异议",
  discomfort: "不适停推",
  decision_support: "比较决策",
  conversation_repair: "理解纠正",
  emotion_acknowledgement: "情绪承接",
  pace_adaptation: "节奏适配",
  routine_fit: "精简步骤",
  existing_routine_respect: "尊重已有护理",
  occasion_fit: "贴合使用场景",
  sensory_preference: "感受偏好确认",
  gentle_recall: "相关偏好回忆",
  respectful_close: "尊重收尾",
};

function optionMemoryLabel(kind: string, value: string | boolean) {
  const kindLabel: Record<string, string> = { routine_preference: "护理步骤", frequent_travel: "出行习惯", fragrance_preference: "香味偏好", texture_preference: "质地偏好", purchase_preference: "购买习惯" };
  return `${kindLabel[kind] ?? kind}：${valueLabels[String(value)] ?? String(value)}`;
}

function displayValue(value: FactValue, field?: string) {
  if (field === "budget" || field === "claimedOnlinePrice") return `¥${Number(value) / 100}`;
  if (Array.isArray(value)) return value.map((item) => valueLabels[item] ?? item).join("、");
  return valueLabels[String(value)] ?? String(value);
}

function RecommendationRows({ result }: { result: DecisionResult }) {
  if (result.action !== "recommend" || !result.recommendations.length) return null;
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
            <p>{item.facts?.join(" · ") ?? item.reasons[0] ?? "商品信息已核实"}</p>
            {item.sku === "P201" ? <p className="tradeoff">用这款时，白天记得做好防晒</p> : null}
          </div>
          <strong>¥{item.priceFen / 100}</strong>
        </article>
      ))}
      {result.pricingMode === "bundle" && result.totalFen ? (
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
          <ClipboardCheck aria-hidden="true" /> 我参考了什么
        </Button>
      </SheetTrigger>
      <SheetContent className="evidence-sheet sm:max-w-[520px]">
        <SheetHeader className="evidence-header">
          <SheetTitle>我参考了什么</SheetTitle>
          <SheetDescription>这里能看到你已经说清楚的需求，以及我核对过的商品资料。</SheetDescription>
        </SheetHeader>
        {result ? (
          <div className="evidence-body">
            <div className="route-card">
              <span>{result.route === "reasoning" ? "仔细比较后再决定" : result.route === "safety" ? "先照顾皮肤状态" : result.route === "degraded" ? "先按已核实资料回答" : "信息已经够用了"}</span>
              <strong>{result.routeReason}</strong>
            </div>
            <Accordion defaultValue={["state", "evidence"]} type="multiple">
              <AccordionItem value="state">
                <AccordionTrigger>你已经说清楚的</AccordionTrigger>
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
                    }) : <p className="muted">这轮还没有需要记下的新信息。</p>}
                  </div>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="evidence">
                <AccordionTrigger>我核对过的资料</AccordionTrigger>
                <AccordionContent>
                  <div className="evidence-list">
                    {result.evidence.length ? result.evidence.map((item) => (
                      <div className="evidence-row" key={item.id}>
                        <span className={`evidence-status ${item.status}`}>{item.status === "supported" ? "已核实" : item.status === "unknown" ? "待确认" : "受限"}</span>
                        <div><strong>{item.label}</strong><p>{item.detail}</p><small>{item.source}</small></div>
                      </div>
                    )) : <p className="muted">这轮没有额外资料需要展开。</p>}
                  </div>
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="candidates">
                <AccordionTrigger>这些商品是怎么筛的</AccordionTrigger>
                <AccordionContent>
                  <div className="fit-grid">
                    {result.productFits.map((fit) => (
                      <div className="fit-row" key={fit.sku}>
                        <strong>{fit.sku}</strong>
                        <span data-status={fit.status}>{fit.status === "eligible" ? "可以继续看" : fit.status === "needs_information" ? "还差一点信息" : "不符合当前条件"}</span>
                        <p>{fit.blockers[0] ?? fit.missing[0] ?? fit.matches[0] ?? "已核对基础商品资料"}</p>
                      </div>
                    ))}
                  </div>
                </AccordionContent>
              </AccordionItem>
              {result.conversationPolicy ? (
                <AccordionItem value="conversation">
                  <AccordionTrigger>这轮我是怎么接着聊的</AccordionTrigger>
                  <AccordionContent>
                    <div className="strategy-list">
                      <p><span>现在在处理</span><strong>{skillLabels[result.conversationPolicy.taskSkill] ?? result.conversationPolicy.taskSkill}</strong></p>
                      <p><span>说话方式</span><strong>{result.conversationPolicy.behaviorSkills.length ? result.conversationPolicy.behaviorSkills.map((skill) => skillLabels[skill] ?? skill).join("、") : "直接回答"}</strong></p>
                      {result.conversationPolicy.acknowledgedSignal?.explicit ? <p><span>刚才接住了</span><q>{result.conversationPolicy.acknowledgedSignal.quote}</q></p> : null}
                      {result.conversationPolicy.usedMemory ? <p><span>参考了你的偏好</span><strong>{optionMemoryLabel(result.conversationPolicy.usedMemory.kind, result.conversationPolicy.usedMemory.value)}</strong></p> : null}
                      <p><span>这句话怎么生成的</span><strong>{result.render?.source === "model" ? "DeepSeek 受控表达" : "本地稳妥表达"}</strong></p>
                      {result.questionFields.length ? <p><span>为什么还要问</span><strong>{result.routeReason}</strong></p> : null}
                    </div>
                  </AccordionContent>
                </AccordionItem>
              ) : null}
              <AccordionItem value="audit">
                <AccordionTrigger>这轮的核对记录</AccordionTrigger>
                <AccordionContent>
                  <div className="audit-summary">
                    <p>输入版本 <strong>{result.versions.input}</strong> · 状态版本 <strong>{result.versions.state}</strong></p>
                    <p>知识版本 <strong>{result.versions.knowledge}</strong></p>
                    {result.decisionTrace ? (
                      <>
                        <p>决策路由 <strong>{result.decisionTrace.routeReason}</strong></p>
                        <p>工具轨迹 <strong>{result.decisionTrace.tools.map((item) => item.tool).join(" → ") || "无"}</strong></p>
                        <p>资格结果 <strong>{result.decisionTrace.eligibility.map((item) => `${item.sku}: ${item.status}`).join("、") || "无"}</strong></p>
                      </>
                    ) : null}
                    {result.agentTrace ? (
                      <>
                        <p>规划步骤 <strong>{result.agentTrace.planner.map((item) => `${item.action}（${item.policy === "allowed" ? "通过" : "拒绝"}）`).join(" → ") || "规则直达"}</strong></p>
                        <p>最终授权 <strong>{result.agentTrace.authorization} · {result.agentTrace.authorizationReason}</strong></p>
                        {result.agentTrace.reasonerProposal ? <p>模型提案 <strong>{result.agentTrace.reasonerProposal.kind === "ask" ? `追问 ${result.agentTrace.reasonerProposal.field}` : result.agentTrace.reasonerProposal.skus.join("、")}</strong></p> : null}
                        {result.agentTrace.fallbackReason ? <p>降级原因 <strong>{result.agentTrace.fallbackReason}</strong></p> : null}
                      </>
                    ) : null}
                    {(result.audits ?? []).map((audit, index) => (
                      <p key={`${audit.stage}-${index}`}>{audit.stage} · {audit.modelInvoked ? `${audit.model} / ${audit.used ? "已采用" : "未采用"}` : "本地降级"} · {audit.latencyMs}ms</p>
                    ))}
                    {result.limitations.map((item) => <p className="limitation" key={item}>还需要留意：{item}</p>)}
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const submitRef = useRef<(text: string) => Promise<DecisionResult | null>>(async () => null);

  const facts = useMemo(() => Object.entries(latestResult?.state.facts ?? {}).slice(0, 6), [latestResult]);

  async function ensureSession() {
    const current = await fetch("/api/session", { cache: "no-store" });
    let payload = await current.json() as SessionPayload;
    if (!current.ok) throw new Error(payload.error ?? "刚才没连上，请稍后再试。");
    if (!payload.session) {
      const created = await fetch("/api/session", { method: "POST" });
      payload = await created.json() as SessionPayload;
      if (!created.ok) throw new Error(payload.error ?? "这次对话没能开始，请稍后再试。");
    }
    setHistory(payload.history ?? []);
    setLatestResult(payload.session?.result ?? null);
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
      if (!response.ok || !payload.result) throw new Error(payload.error ?? "这次没能给出可靠结果。");
      setLatestResult(payload.result);
      setHistory((items) => items.map((item) => item.requestId === requestId ? { ...item, status: "complete", result: payload.result! } : item));
      return payload.result;
    } catch (error) {
      setHistory((items) => items.filter((item) => item.requestId !== requestId));
      setServiceError(error instanceof Error ? error.message : "现在暂时连不上，请稍后再试。");
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
    try { await ensureSession(); } catch (error) { setServiceError(error instanceof Error ? error.message : "这次对话没能开始，请稍后再试。"); }
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
            text: result ? JSON.stringify({ action: result.action, reply: result.reply, recommendations: result.recommendations, totalFen: result.totalFen, limitations: result.limitations, conversationSkill: result.conversationPolicy?.taskSkill, renderSource: result.render?.source, versions: result.versions }) : JSON.stringify({ error: "这次没能给出可靠结果" }),
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
          <span className="service-state"><i /> 商品资料已核对</span>
          <PreferencesDrawer />
          <Button variant="ghost" className="reset-button" onClick={resetSession} disabled={loading || sending}><RotateCcw /> 从头聊</Button>
          <EvidenceDrawer result={latestResult} />
        </div>
      </header>

      <div className="workspace">
        <aside className="case-sheet" aria-label="我记下的需求">
          <h2>我记下的需求</h2>
          <p className="aside-lead">这里只放你说过、现在还算数的信息。</p>
          <div className="fact-stack">
            {facts.length ? facts.map(([field, raw]) => {
              const item = raw as SourcedFact;
              return <div className="brief-fact" key={field}><span>{fieldLabels[field] ?? field}</span><strong>{displayValue(item.value, field)}</strong></div>;
            }) : <div className="empty-brief"><Sparkles aria-hidden="true" /><p>先说想找什么就好。我一次只问一个关键问题。</p></div>}
          </div>
          <div className="privacy-note"><ShieldCheck aria-hidden="true" /><p>这次聊天会保留 24 小时。想换设备也沿用偏好，可以登录后在“我的偏好”里开启。</p></div>
        </aside>

        <section className="conversation" id="main-conversation" aria-busy={sending || loading}>
          <div className="conversation-header">
            <div><h1>说说你想找什么，我陪你慢慢挑</h1></div>
            <span>{history.length ? `聊到第 ${history.length} 轮` : "刚开始"}</span>
          </div>

          <div className="messages" aria-live="polite">
            {!history.length && !loading ? (
              <div className="welcome-block">
                <p>嗨，我是澄初导购。你可以先说想找哪类、在意什么，或者哪里拿不准。我一次只问一个关键问题，陪你把选择慢慢缩小。</p>
                <div className="starter-grid">
                  {starters.map((starter) => <button key={starter} onClick={() => submit(starter)}>{starter}<ArrowUp aria-hidden="true" /></button>)}
                </div>
              </div>
            ) : null}
            {loading ? <div className="loading-line">正在接上刚才聊到的地方…</div> : null}
            {history.map((item, index) => (
              <div className="turn" key={item.requestId}>
                <div className="user-message"><span>你</span><p>{item.text}</p></div>
                {item.result ? (
                  <div className="assistant-message">
                    <div className="advisor-avatar" aria-hidden="true">澄</div>
                    <div className="assistant-content">
                      <p>{item.result.reply}</p>
                      {index === history.length - 1 && item.result.action === "clarify" && item.result.questionOptions?.length ? (
                        <div className="answer-options" role="group" aria-label="选一个接近的回答，也可以自己说">
                          {item.result.questionOptions.map((option) => (
                            <button type="button" key={option.id} disabled={sending || loading} onClick={() => void submit(option.answerText)}>{option.label}</button>
                          ))}
                          <button type="button" className="answer-custom" disabled={sending || loading} onClick={() => inputRef.current?.focus()}>自己说</button>
                        </div>
                      ) : null}
                      <RecommendationRows result={item.result} />
                      <button className="inline-evidence" onClick={() => setLatestResult(item.result)}>{item.result.evidence.length ? `核对了 ${item.result.evidence.length} 条资料 · 看看依据` : "看看这条回复的依据"}</button>
                    </div>
                  </div>
                ) : <div className="assistant-message"><div className="advisor-avatar">澄</div><div className="thinking-line"><i /><i /><i /><span>我在核对商品资料，稍等一下</span></div></div>}
              </div>
            ))}
            {serviceError ? <div className="service-error" role="alert"><strong>刚才没接上</strong><p>{serviceError} 前面聊过的内容还在，稍后再试就好。</p></div> : null}
            <div ref={bottomRef} />
          </div>

          <form className="composer" onSubmit={(event) => { event.preventDefault(); submit(); }}>
            <label htmlFor="guide-input">你接着说</label>
            <div className="composer-row">
              <Textarea ref={inputRef} id="guide-input" value={input} maxLength={600} disabled={sending || loading} onChange={(event) => setInput(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); submit(); } }} placeholder="选项不合适，也可以直接说…" />
              <Button type="submit" size="icon" aria-label="发送" disabled={!input.trim() || sending || loading}><ArrowUp /></Button>
            </div>
            <div className="composer-meta"><span>Enter 发送 · Shift + Enter 换行</span><span>{input.length}/600</span></div>
          </form>
        </section>
      </div>
    </main>
  );
}
