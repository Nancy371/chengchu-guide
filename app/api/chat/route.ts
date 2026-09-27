import { NextRequest, NextResponse } from "next/server";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { ConversationRuntime } from "@/lib/guide/runtime";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const user = await getChatGPTUser();
  const sessionId = request.cookies.get("chengchu_session")?.value;
  if (!sessionId) return NextResponse.json({ error: "这次聊天已经过期了，刷新页面就能重新开始。" }, { status: 401 });
  let body: { requestId?: string; text?: string };
  try { body = await request.json(); } catch { return NextResponse.json({ error: "这条消息没有成功提交，请重新发送。" }, { status: 400 }); }
  const text = body.text?.trim() ?? "";
  const requestId = body.requestId?.trim() ?? "";
  if (!requestId || !text) return NextResponse.json({ error: "先写点想问的内容再发送。" }, { status: 400 });
  if (text.length > 600) return NextResponse.json({ error: "这条有点长，请控制在 600 字以内。" }, { status: 400 });
  try {
    return NextResponse.json(await new ConversationRuntime().handleTurn(sessionId, requestId, text, user?.userId ?? null));
  } catch (error) {
    const code = error instanceof Error ? error.message : "unknown";
    if (code === "request_processing") return NextResponse.json({ error: "这条还在处理，稍等一下就好。" }, { status: 409 });
    if (code.startsWith("rate_limit")) return NextResponse.json({ error: "消息发得有点快，缓一下再试。" }, { status: 429 });
    if (code === "session_not_found") return NextResponse.json({ error: "这次聊天已经过期了，刷新页面就能重新开始。" }, { status: 401 });
    return NextResponse.json({ error: "这次没能可靠判断。前面确认的信息还在，稍后再试就好。" }, { status: 503 });
  }
}
