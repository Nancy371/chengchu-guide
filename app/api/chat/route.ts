import { NextRequest, NextResponse } from "next/server";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { ConversationRuntime } from "@/lib/guide/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  const sessionId = request.cookies.get("chengchu_session")?.value;
  if (!sessionId) return NextResponse.json({ error: "会话已失效，请刷新后重试。" }, { status: 401 });
  let body: { requestId?: string; text?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "输入格式不正确。" }, { status: 400 }); }
  const text = body.text?.trim() ?? "";
  const requestId = body.requestId?.trim() ?? "";
  if (!requestId || !text) return NextResponse.json({ error: "请输入要咨询的内容。" }, { status: 400 });
  if (text.length > 600) return NextResponse.json({ error: "单次输入请控制在 600 字以内。" }, { status: 400 });
  try {
    return NextResponse.json(await new ConversationRuntime().handleTurn(sessionId, requestId, text, user?.userId ?? null));
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    if (code === "request_processing") return NextResponse.json({ error: "这条消息仍在处理中，请稍候。" }, { status: 409 });
    if (code.startsWith("rate_limit")) return NextResponse.json({ error: "发送得有点快，请稍后再试。" }, { status: 429 });
    if (code === "session_not_found") return NextResponse.json({ error: "会话已过期，请刷新后重试。" }, { status: 401 });
    return NextResponse.json({ error: "本轮暂时无法完成判断，已保留之前确认的信息。请稍后重试。" }, { status: 503 });
  }
}
