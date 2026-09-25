import { NextRequest, NextResponse } from "next/server";
import { D1GuideRepository } from "@/lib/guide/repository";

export const dynamic = "force-dynamic";
const COOKIE = "chengchu_session";
const secureCookie = process.env.NODE_ENV === "production";

function sessionId(request: NextRequest) {
  return request.cookies.get(COOKIE)?.value ?? "";
}

export async function POST() {
  try {
    const session = await new D1GuideRepository().createSession();
    const response = NextResponse.json({ session, history: [] });
    response.cookies.set(COOKIE, session.id, { httpOnly: true, sameSite: "lax", secure: secureCookie, path: "/", maxAge: 24 * 60 * 60 });
    return response;
  } catch {
    return NextResponse.json({ error: "会话服务暂时不可用，请稍后重试。" }, { status: 503 });
  }
}

export async function GET(request: NextRequest) {
  try {
    const id = sessionId(request);
    if (!id) return NextResponse.json({ session: null, history: [] });
    const repository = new D1GuideRepository();
    const session = await repository.getSession(id);
    if (!session) return NextResponse.json({ session: null, history: [] });
    return NextResponse.json({ session, history: await repository.getHistory(id) });
  } catch {
    return NextResponse.json({ error: "暂时无法恢复会话。" }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  const response = NextResponse.json({ ok: true });
  try {
    const id = sessionId(request);
    if (id) await new D1GuideRepository().deleteSession(id);
  } finally {
    response.cookies.set(COOKIE, "", { httpOnly: true, sameSite: "lax", secure: secureCookie, path: "/", maxAge: 0 });
  }
  return response;
}
