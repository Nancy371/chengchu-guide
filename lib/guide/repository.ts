import { env } from "cloudflare:workers";
import { EMPTY_STATE } from "./state";
import type { DecisionResult, SessionRecord, UserState } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;

type SessionRow = {
  id: string;
  state_json: string;
  input_version: number;
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
    state: parse<UserState>(row.state_json, EMPTY_STATE),
    inputVersion: row.input_version,
    stateVersion: row.state_version,
    result: parse<DecisionResult | null>(row.result_json, null),
  };
}

export interface BeginTurnResult {
  duplicate: boolean;
  processing?: boolean;
  session: SessionRecord;
  previousResult?: DecisionResult | null;
  response?: DecisionResult | null;
}

export class D1GuideRepository {
  async createSession(): Promise<SessionRecord> {
    const id = crypto.randomUUID();
    const now = Date.now();
    await db().prepare("INSERT INTO sessions (id, state_json, input_version, state_version, result_json, created_at, updated_at, expires_at) VALUES (?, ?, 0, 0, NULL, ?, ?, ?)")
      .bind(id, JSON.stringify(EMPTY_STATE), now, now, now + DAY_MS).run();
    return { id, state: EMPTY_STATE, inputVersion: 0, stateVersion: 0, result: null };
  }

  async getSession(id: string): Promise<SessionRecord | null> {
    const row = await db().prepare("SELECT id, state_json, input_version, state_version, result_json FROM sessions WHERE id = ? AND expires_at > ?")
      .bind(id, Date.now()).first<SessionRow>();
    return row ? mapSession(row) : null;
  }

  async getHistory(id: string) {
    const rows = await db().prepare("SELECT request_id, text, status, response_json, created_at FROM requests WHERE session_id = ? AND status IN ('complete', 'stale') ORDER BY created_at ASC LIMIT 60")
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

  async beginTurn(sessionId: string, requestId: string, text: string): Promise<BeginTurnResult> {
    const existing = await db().prepare("SELECT status, response_json FROM requests WHERE session_id = ? AND request_id = ?")
      .bind(sessionId, requestId).first<{ status: string; response_json: string | null }>();
    const current = await this.getSession(sessionId);
    if (!current) throw new Error("session_not_found");
    if (existing) return { duplicate: true, processing: existing.status === "processing", session: current, response: parse(existing.response_json, current.result) };
    await this.assertRateLimit(sessionId);
    const now = Date.now();
    await db().prepare("INSERT INTO requests (id, session_id, request_id, text, status, input_version, response_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'processing', NULL, NULL, ?, ?)")
      .bind(`${sessionId}:${requestId}`, sessionId, requestId, text, now, now).run();
    const row = await db().prepare("UPDATE sessions SET input_version = input_version + 1, result_json = NULL, updated_at = ?, expires_at = ? WHERE id = ? RETURNING id, state_json, input_version, state_version, result_json")
      .bind(now, now + DAY_MS, sessionId).first<SessionRow>();
    if (!row) throw new Error("session_not_found");
    await db().prepare("UPDATE requests SET input_version = ?, updated_at = ? WHERE session_id = ? AND request_id = ?")
      .bind(row.input_version, now, sessionId, requestId).run();
    return { duplicate: false, session: mapSession(row), previousResult: current.result };
  }

  async commitState(sessionId: string, inputVersion: number, expectedStateVersion: number, state: UserState) {
    const row = await db().prepare("UPDATE sessions SET state_json = ?, state_version = state_version + 1, updated_at = ? WHERE id = ? AND input_version = ? AND state_version = ? RETURNING id, state_json, input_version, state_version, result_json")
      .bind(JSON.stringify(state), Date.now(), sessionId, inputVersion, expectedStateVersion).first<SessionRow>();
    return row ? mapSession(row) : null;
  }

  async commitResult(sessionId: string, requestId: string, inputVersion: number, expectedStateVersion: number, result: DecisionResult) {
    const payload = JSON.stringify(result);
    const row = await db().prepare("UPDATE sessions SET result_json = ?, updated_at = ? WHERE id = ? AND input_version = ? AND state_version = ? RETURNING id")
      .bind(payload, Date.now(), sessionId, inputVersion, expectedStateVersion).first<{ id: string }>();
    const status = row ? "complete" : "stale";
    await db().prepare("UPDATE requests SET status = ?, response_json = ?, updated_at = ? WHERE session_id = ? AND request_id = ?")
      .bind(status, payload, Date.now(), sessionId, requestId).run();
    return Boolean(row);
  }

  async failTurn(sessionId: string, requestId: string, response: DecisionResult | null) {
    await db().prepare("UPDATE requests SET status = 'failed', response_json = ?, updated_at = ? WHERE session_id = ? AND request_id = ?")
      .bind(response ? JSON.stringify(response) : null, Date.now(), sessionId, requestId).run();
  }

  async deleteSession(id: string) {
    await db().batch([
      db().prepare("DELETE FROM requests WHERE session_id = ?").bind(id),
      db().prepare("DELETE FROM sessions WHERE id = ?").bind(id),
    ]);
  }
}
