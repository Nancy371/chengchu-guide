import { NextRequest, NextResponse } from "next/server";
import { getChatGPTUser } from "@/app/chatgpt-auth";
import { D1GuideRepository } from "@/lib/guide/repository";
import type { HabitKind, HabitMemory, MemoryProfile } from "@/lib/guide/types";

export const dynamic = "force-dynamic";

const allowedValues: Record<HabitKind, ReadonlySet<string | boolean>> = {
  routine_preference: new Set(["simple"]),
  frequent_travel: new Set([true, false]),
  fragrance_preference: new Set(["must_be_fragrance_free", "fragrance_sensitive", "accepts_fragrance"]),
  texture_preference: new Set(["lightweight"]),
  purchase_preference: new Set(["single_item", "avoid_duplicate"]),
};

function response(profile: Omit<MemoryProfile, "authenticated">, user: NonNullable<Awaited<ReturnType<typeof getChatGPTUser>>>) {
  return NextResponse.json({ ...profile, authenticated: true, account: { displayName: user.displayName, email: user.email } } satisfies MemoryProfile);
}

export async function GET() {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ authenticated: false, enabled: false, version: 0, memories: [] } satisfies MemoryProfile);
  try {
    return response(await new D1GuideRepository().getMemoryProfile(user.userId), user);
  } catch {
    return NextResponse.json({ error: "暂时无法读取偏好。" }, { status: 503 });
  }
}

export async function PUT(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "请先登录后再开启跨设备记忆。" }, { status: 401 });
  const body = await request.json().catch(() => null) as { enabled?: unknown; expectedVersion?: unknown } | null;
  if (typeof body?.enabled !== "boolean" || !Number.isInteger(body.expectedVersion)) return NextResponse.json({ error: "设置参数不正确。" }, { status: 400 });
  try {
    return response(await new D1GuideRepository().setMemoryEnabled(user.userId, body.enabled, body.expectedVersion as number), user);
  } catch (error) {
    if (error instanceof Error && error.message === "memory_version_conflict") return NextResponse.json({ error: "偏好设置已在其他设备更新，请刷新后重试。" }, { status: 409 });
    return NextResponse.json({ error: "暂时无法更新偏好设置。" }, { status: 503 });
  }
}

export async function PATCH(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  const body = await request.json().catch(() => null) as { id?: unknown; value?: unknown } | null;
  if (typeof body?.id !== "string" || !["string", "boolean"].includes(typeof body.value)) return NextResponse.json({ error: "修改参数不正确。" }, { status: 400 });
  const repository = new D1GuideRepository();
  try {
    const profile = await repository.getMemoryProfile(user.userId);
    const memory = profile.memories.find((item: HabitMemory) => item.id === body.id);
    if (!memory) return NextResponse.json({ error: "这项偏好不存在或已过期。" }, { status: 404 });
    if (!allowedValues[memory.kind].has(body.value as string | boolean)) return NextResponse.json({ error: "该偏好值不在允许范围内。" }, { status: 400 });
    return response(await repository.updateMemory(user.userId, body.id, body.value as string | boolean), user);
  } catch {
    return NextResponse.json({ error: "暂时无法修改偏好。" }, { status: 503 });
  }
}

export async function DELETE(request: NextRequest) {
  const user = await getChatGPTUser();
  if (!user) return NextResponse.json({ error: "请先登录。" }, { status: 401 });
  const body = await request.json().catch(() => ({})) as { id?: unknown; all?: unknown; disable?: unknown; expectedVersion?: unknown };
  const repository = new D1GuideRepository();
  try {
    if (body.disable === true) {
      if (!Number.isInteger(body.expectedVersion)) return NextResponse.json({ error: "设置版本不正确。" }, { status: 400 });
      return response(await repository.setMemoryEnabled(user.userId, false, body.expectedVersion as number), user);
    }
    if (body.all === true) return response(await repository.clearMemories(user.userId), user);
    if (typeof body.id === "string") return response(await repository.deleteMemory(user.userId, body.id), user);
    return NextResponse.json({ error: "请选择要删除的偏好。" }, { status: 400 });
  } catch (error) {
    if (error instanceof Error && error.message === "memory_version_conflict") return NextResponse.json({ error: "偏好设置已在其他设备更新，请刷新后重试。" }, { status: 409 });
    return NextResponse.json({ error: "暂时无法删除偏好。" }, { status: 503 });
  }
}
