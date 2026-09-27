import { env } from "cloudflare:workers";
import { EMPTY_STATE } from "./state";
import type { DecisionResult, HabitKind, HabitMemory, LifestyleObservation, SessionRecord, UserState } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const MEMORY_TTL_MS = 90 * DAY_MS;

type SessionRow = {
  id: string;
  user_id: string | null;
  state_json: string;
  input_version: number;
  applied_input_version: number;
  state_version: number;
  result_json: string | null;
};

function db(): D1Database {
  const binding = (env as unknown as { DB?: D1Database }).DB;
  if (!binding) throw new Error("database_unavailable");
  return binding;
}

function parse<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    userId: row.user_id,
    state: parse<UserState>(row.state_json, EMPTY_STATE),
    inputVersion: row.input_version,
    appliedInputVersion: row.applied_input_version,
    stateVersion: row.state_version,
    result: parse<DecisionResult | null>(row.result_json, null),
  };
}

export interface BeginTurnResult {
  duplicate: boolean;
  processing?: boolean;
  session: SessionRecord;
  inputVersion: number;
  previousResult?: DecisionResult | null;
  response?: DecisionResult | null;
}

export class D1GuideRepository {
  async createSession(userId: string | null = null): Promise<SessionRecord> {
    const id = crypto.randomUUID();
    const now = Date.now();
    await db().prepare("INSERT INTO sessions (id, user_id, state_json, input_version, applied_input_version, state_version, result_json, created_at, updated_at, expires_at) VALUES (?, ?, ?, 0, 0, 0, NULL, ?, ?, ?)")
      .bind(id, userId, JSON.stringify(EMPTY_STATE), now, now, now + DAY_MS).run();
    return { id, userId, state: EMPTY_STATE, inputVersion: 0, appliedInputVersion: 0, stateVersion: 0, result: null };
  }

  async getSession(id: string, userId?: string | null): Promise<SessionRecord | null> {
    const row = await db().prepare("SELECT id, user_id, state_json, input_version, applied_input_version, state_version, result_json FROM sessions WHERE id = ? AND expires_at > ?")
      .bind(id, Date.now()).first<SessionRow>();
    if (!row || (userId !== undefined && row.user_id !== userId)) return null;
    return mapSession(row);
  }

  async getHistory(id: string, userId?: string | null) {
    if (!(await this.getSession(id, userId))) return [];
    const rows = await db().prepare("SELECT request_id, text, status, response_json, created_at FROM requests WHERE session_id = ? AND status IN ('complete', 'stale') ORDER BY input_version ASC LIMIT 60")
      .bind(id).all<{ request_id: string; text: string; status: string; response_json: string | null; created_at: number }>();
    return rows.results.map((row) => ({
      requestId: row.request_id,
      text: row.text,
      status: row.status,
      result: parse<DecisionResult | null>(row.response_json, null),
      createdAt: row.created_at,
    }));
  }

  async assertRateLimit(sessionId: string) {
    const now = Date.now();
    const [minute, day, global] = await Promise.all([
      db().prepare("SELECT COUNT(*) AS count FROM requests WHERE session_id = ? AND created_at >= ?").bind(sessionId, now - 60_000).first<{ count: number }>(),
      db().prepare("SELECT COUNT(*) AS count FROM requests WHERE session_id = ? AND created_at >= ?").bind(sessionId, now - DAY_MS).first<{ count: number }>(),
      db().prepare("SELECT COUNT(*) AS count FROM requests WHERE created_at >= ?").bind(now - DAY_MS).first<{ count: number }>(),
    ]);
    if ((minute?.count ?? 0) >= 6) throw new Error("rate_limit_minute");
    if ((day?.count ?? 0) >= 50) throw new Error("rate_limit_day");
    if ((global?.count ?? 0) >= 500) throw new Error("rate_limit_global");
  }

  async beginTurn(sessionId: string, requestId: string, text: string, userId: string | null = null): Promise<BeginTurnResult> {
    const existing = await db().prepare("SELECT status, input_version, response_json FROM requests WHERE session_id = ? AND request_id = ?")
      .bind(sessionId, requestId).first<{ status: string; input_version: number | null; response_json: string | null }>();
    const current = await this.getSession(sessionId, userId);
    if (!current) throw new Error("session_not_found");
    if (existing) return { duplicate: true, processing: existing.status === "processing", session: current, inputVersion: existing.input_version ?? current.inputVersion, response: parse(existing.response_json, null) };
    await this.assertRateLimit(sessionId);
    const now = Date.now();
    try {
      await db().batch([
        db().prepare("INSERT INTO requests (id, session_id, request_id, text, status, input_version, response_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'processing', NULL, NULL, ?, ?)")
          .bind(`${sessionId}:${requestId}`, sessionId, requestId, text, now, now),
        db().prepare("UPDATE sessions SET input_version = input_version + 1, result_json = NULL, updated_at = ?, expires_at = ? WHERE id = ? AND ((user_id = ?) OR (user_id IS NULL AND ? IS NULL))")
          .bind(now, now + DAY_MS, sessionId, userId, userId),
        db().prepare("UPDATE requests SET input_version = (SELECT input_version FROM sessions WHERE id = ?), updated_at = ? WHERE session_id = ? AND request_id = ?")
          .bind(sessionId, now, sessionId, requestId),
      ]);
    } catch (error) {
      const duplicate = await db().prepare("SELECT status, input_version, response_json FROM requests WHERE session_id = ? AND request_id = ?")
        .bind(sessionId, requestId).first<{ status: string; input_version: number | null; response_json: string | null }>();
      if (!duplicate) throw error;
      const latest = await this.getSession(sessionId, userId);
      if (!latest) throw new Error("session_not_found");
      return { duplicate: true, processing: duplicate.status === "processing", session: latest, inputVersion: duplicate.input_version ?? latest.inputVersion, response: parse(duplicate.response_json, null) };
    }
    const request = await db().prepare("SELECT input_version FROM requests WHERE session_id = ? AND request_id = ?")
      .bind(sessionId, requestId).first<{ input_version: number | null }>();
    if (request?.input_version == null) throw new Error("session_not_found");
    return { duplicate: false, session: (await this.getSession(sessionId, userId))!, inputVersion: request.input_version, previousResult: current.result };
  }

  async getPendingInput(sessionId: string, inputVersion: number, userId: string | null) {
    if (!(await this.getSession(sessionId, userId))) return null;
    return db().prepare("SELECT request_id, text, created_at FROM requests WHERE session_id = ? AND input_version = ?")
      .bind(sessionId, inputVersion).first<{ request_id: string; text: string; created_at: number }>();
  }

  async commitState(sessionId: string, inputVersion: number, expectedStateVersion: number, state: UserState) {
    const row = await db().prepare("UPDATE sessions SET state_json = ?, applied_input_version = ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND input_version >= ? AND applied_input_version = ? AND state_version = ? RETURNING id, user_id, state_json, input_version, applied_input_version, state_version, result_json")
      .bind(JSON.stringify(state), inputVersion, Date.now(), sessionId, inputVersion, inputVersion - 1, expectedStateVersion).first<SessionRow>();
    return row ? mapSession(row) : null;
  }

  async commitResult(sessionId: string, requestId: string, inputVersion: number, expectedStateVersion: number, result: DecisionResult) {
    const payload = JSON.stringify(result);
    const row = await db().prepare("UPDATE sessions SET result_json = ?, updated_at = ? WHERE id = ? AND input_version = ? AND applied_input_version = ? AND state_version = ? RETURNING id")
      .bind(payload, Date.now(), sessionId, inputVersion, inputVersion, expectedStateVersion).first<{ id: string }>();
    if (row) await db().prepare("UPDATE requests SET status = 'complete', response_json = ?, updated_at = ? WHERE session_id = ? AND request_id = ? AND status = 'processing'")
      .bind(payload, Date.now(), sessionId, requestId).run();
    return Boolean(row);
  }

  async failTurn(sessionId: string, requestId: string, response: DecisionResult | null) {
    await db().prepare("UPDATE requests SET status = 'stale', response_json = ?, updated_at = ? WHERE session_id = ? AND request_id = ? AND status = 'processing'")
      .bind(response ? JSON.stringify(response) : null, Date.now(), sessionId, requestId).run();
  }

  async deleteSession(id: string, userId: string | null = null) {
    const session = await this.getSession(id, userId);
    if (!session) return;
    await db().batch([
      db().prepare("DELETE FROM requests WHERE session_id = ?").bind(id),
      db().prepare("DELETE FROM sessions WHERE id = ?").bind(id),
    ]);
  }

  async getMemoryProfile(userId: string): Promise<{ enabled: boolean; version: number; memories: HabitMemory[] }> {
    const now = Date.now();
    await db().prepare("DELETE FROM habit_memories WHERE user_id = ? AND expires_at <= ?").bind(userId, now).run();
    const setting = await db().prepare("SELECT enabled, version FROM memory_settings WHERE user_id = ?").bind(userId).first<{ enabled: number; version: number }>();
    if (!setting?.enabled) return { enabled: false, version: setting?.version ?? 0, memories: [] };
    const rows = await db().prepare("SELECT id, kind, value_json, source_turn, updated_at, expires_at FROM habit_memories WHERE user_id = ? AND expires_at > ? ORDER BY updated_at DESC")
      .bind(userId, now).all<{ id: string; kind: HabitKind; value_json: string; source_turn: number; updated_at: number; expires_at: number }>();
    return {
      enabled: true,
      version: setting.version,
      memories: rows.results.flatMap((row) => {
        const value = parse<string | boolean | null>(row.value_json, null);
        return value === null ? [] : [{ id: row.id, kind: row.kind, value, sourceTurn: row.source_turn, updatedAt: row.updated_at, expiresAt: row.expires_at }];
      }),
    };
  }

  async setMemoryEnabled(userId: string, enabled: boolean, expectedVersion: number) {
    const now = Date.now();
    const current = await db().prepare("SELECT version FROM memory_settings WHERE user_id = ?").bind(userId).first<{ version: number }>();
    if (!current) {
      if (expectedVersion !== 0) throw new Error("memory_version_conflict");
      await db().prepare("INSERT INTO memory_settings (user_id, enabled, version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)").bind(userId, enabled ? 1 : 0, now, now).run();
    } else {
      const updated = await db().prepare("UPDATE memory_settings SET enabled = ?, version = version + 1, updated_at = ? WHERE user_id = ? AND version = ? RETURNING version")
        .bind(enabled ? 1 : 0, now, userId, expectedVersion).first<{ version: number }>();
      if (!updated) throw new Error("memory_version_conflict");
    }
    if (!enabled) await db().prepare("DELETE FROM habit_memories WHERE user_id = ?").bind(userId).run();
    return this.getMemoryProfile(userId);
  }

  async updateMemory(userId: string, id: string, value: string | boolean) {
    const now = Date.now();
    const updated = await db().prepare("UPDATE habit_memories SET value_json = ?, updated_at = ?, expires_at = ? WHERE id = ? AND user_id = ? RETURNING id")
      .bind(JSON.stringify(value), now, now + MEMORY_TTL_MS, id, userId).first<{ id: string }>();
    if (!updated) throw new Error("memory_not_found");
    await db().prepare("UPDATE memory_settings SET version = version + 1, updated_at = ? WHERE user_id = ?").bind(now, userId).run();
    return this.getMemoryProfile(userId);
  }

  async deleteMemory(userId: string, id: string) {
    const now = Date.now();
    await db().batch([
      db().prepare("UPDATE memory_settings SET version = version + 1, updated_at = ? WHERE user_id = ?").bind(now, userId),
      db().prepare("DELETE FROM habit_memories WHERE id = ? AND user_id = ?").bind(id, userId),
    ]);
    return this.getMemoryProfile(userId);
  }

  async clearMemories(userId: string) {
    const now = Date.now();
    await db().batch([
      db().prepare("UPDATE memory_settings SET version = version + 1, updated_at = ? WHERE user_id = ?").bind(now, userId),
      db().prepare("DELETE FROM habit_memories WHERE user_id = ?").bind(userId),
    ]);
    return this.getMemoryProfile(userId);
  }

  async saveHabitObservations(args: { userId: string; sessionId: string; inputVersion: number; stateVersion: number; settingsVersion: number; turn: number; observations: LifestyleObservation[] }) {
    const observations = args.observations.filter((item) => item.scope === "durable" && item.explicit && item.subject === "self");
    if (!observations.length) return;
    const now = Date.now();
    for (const item of observations) {
      await db().prepare(`INSERT INTO habit_memories (id, user_id, kind, value_json, source_session_id, source_turn, created_at, updated_at, expires_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM memory_settings WHERE user_id = ? AND enabled = 1 AND version = ?)
          AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND user_id = ? AND input_version = ? AND state_version = ?)
        ON CONFLICT(user_id, kind) DO UPDATE SET value_json = excluded.value_json, source_session_id = excluded.source_session_id, source_turn = excluded.source_turn, updated_at = excluded.updated_at, expires_at = excluded.expires_at`)
        .bind(crypto.randomUUID(), args.userId, item.kind, JSON.stringify(item.value), args.sessionId, args.turn, now, now, now + MEMORY_TTL_MS, args.userId, args.settingsVersion, args.sessionId, args.userId, args.inputVersion, args.stateVersion).run();
    }
  }
}
