"use client";

import { useEffect, useState } from "react";
import { LogIn, Settings2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { HabitKind, HabitMemory, MemoryProfile } from "@/lib/guide/types";

const emptyProfile: MemoryProfile = { authenticated: false, enabled: false, version: 0, memories: [] };

const kindLabels: Record<HabitKind, string> = {
  routine_preference: "护理步骤",
  frequent_travel: "出行习惯",
  fragrance_preference: "香味偏好",
  texture_preference: "质地偏好",
  purchase_preference: "购买习惯",
};

const optionLabels: Record<string, string> = {
  simple: "希望步骤简单",
  true: "经常出差",
  false: "不常出差",
  must_be_fragrance_free: "只选无香",
  fragrance_sensitive: "对香味敏感",
  accepts_fragrance: "可以接受香味",
  lightweight: "偏好轻薄、不黏",
  single_item: "倾向单品购买",
  avoid_duplicate: "避免重复购买",
};

const options: Record<HabitKind, Array<string | boolean>> = {
  routine_preference: ["simple"],
  frequent_travel: [true, false],
  fragrance_preference: ["must_be_fragrance_free", "fragrance_sensitive", "accepts_fragrance"],
  texture_preference: ["lightweight"],
  purchase_preference: ["single_item", "avoid_duplicate"],
};

export function PreferencesDrawer() {
  const [profile, setProfile] = useState<MemoryProfile>(emptyProfile);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function load() {
    const request = await fetch("/api/preferences", { cache: "no-store" });
    const data = await request.json() as MemoryProfile & { error?: string };
    if (!request.ok) throw new Error(data.error ?? "刚才没能读到你的偏好。");
    setProfile(data);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load().catch((cause: Error) => setError(cause.message));
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  async function mutate(method: "PUT" | "PATCH" | "DELETE", body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const request = await fetch("/api/preferences", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await request.json() as MemoryProfile & { error?: string };
      if (!request.ok) throw new Error(data.error ?? "刚才没能保存这项修改。");
      setProfile(data);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "刚才没能保存这项修改。");
      if (method !== "PATCH") await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  function serialized(value: string | boolean) {
    return String(value);
  }

  function parsed(memory: HabitMemory, value: string): string | boolean {
    return memory.kind === "frequent_travel" ? value === "true" : value;
  }

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button className="preferences-button" variant="ghost"><Settings2 aria-hidden="true" /> 我的偏好</Button>
      </SheetTrigger>
      <SheetContent className="preferences-sheet sm:max-w-[480px]">
        <SheetHeader className="preferences-header">
          <SheetTitle>我的偏好</SheetTitle>
          <SheetDescription>登录后，可以在不同设备沿用你明确保存的习惯。商品、安全和预算仍以这次聊天为准。</SheetDescription>
        </SheetHeader>
        <div className="preferences-body">
          {!profile.authenticated ? (
            <div className="signin-panel">
              <h3>登录后才能跨设备记住习惯</h3>
              <p>不登录也能正常咨询。登录以后，记忆也不会自动开启。</p>
              <Button asChild><a href="/signin-with-chatgpt?return_to=%2F" target="_top"><LogIn aria-hidden="true" /> 使用 ChatGPT 登录</a></Button>
            </div>
          ) : (
            <>
              <div className="account-line">
                <div><strong>{profile.account?.displayName}</strong><span>{profile.account?.email}</span></div>
                <a href="/signout-with-chatgpt?return_to=%2F" target="_top">退出</a>
              </div>
              <div className="memory-consent">
                <div>
                  <strong>在不同设备记住我的习惯</strong>
                  <p>开启后，只保存你之后明确说出的允许项，90 天后自动过期。情绪、不适、病史、预算和行程都不会保存。</p>
                </div>
                <Switch
                  aria-label="在不同设备记住我的习惯"
                  checked={profile.enabled}
                  disabled={busy}
                  onCheckedChange={(enabled) => void mutate("PUT", { enabled, expectedVersion: profile.version })}
                />
              </div>
              {profile.enabled ? (
                <div className="memory-list">
                  <div className="memory-list-heading"><strong>已保存 {profile.memories.length} 项</strong>{profile.memories.length ? <button disabled={busy} onClick={() => void mutate("DELETE", { all: true })}>清空</button> : null}</div>
                  {profile.memories.length ? profile.memories.map((memory) => (
                    <div className="memory-row" key={memory.id}>
                      <div><span>{kindLabels[memory.kind]}</span><small>有效至 {new Date(memory.expiresAt).toLocaleDateString("zh-CN")}</small></div>
                      <Select value={serialized(memory.value)} disabled={busy} onValueChange={(value) => void mutate("PATCH", { id: memory.id, value: parsed(memory, value) })}>
                        <SelectTrigger aria-label={"修改" + kindLabels[memory.kind]}><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {options[memory.kind].map((value) => <SelectItem key={serialized(value)} value={serialized(value)}>{optionLabels[serialized(value)]}</SelectItem>)}
                        </SelectContent>
                      </Select>
                      <Button size="icon" variant="ghost" aria-label={"删除" + kindLabels[memory.kind]} disabled={busy} onClick={() => void mutate("DELETE", { id: memory.id })}><Trash2 /></Button>
                    </div>
                  )) : <p className="memory-empty">还没有保存的偏好。开启后，只有你明确说出“我喜欢无香”或“我经常出差”这类习惯时，我才会记下来。</p>}
                  <button className="disable-memory" disabled={busy} onClick={() => void mutate("DELETE", { disable: true, expectedVersion: profile.version })}>关闭并清除记忆</button>
                </div>
              ) : (
                <p className="memory-off">记忆现在是关着的。你提到的生活偏好只会用于这次聊天。</p>
              )}
            </>
          )}
          {error ? <p className="preferences-error" role="alert">{error}</p> : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
