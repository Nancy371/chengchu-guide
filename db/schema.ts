import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id"),
  stateJson: text("state_json").notNull(),
  inputVersion: integer("input_version").notNull().default(0),
  stateVersion: integer("state_version").notNull().default(0),
  resultJson: text("result_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [index("sessions_expires_idx").on(table.expiresAt), index("sessions_user_updated_idx").on(table.userId, table.updatedAt)]);

export const requests = sqliteTable("requests", {
  id: text("id").primaryKey(),
  sessionId: text("session_id").notNull(),
  requestId: text("request_id").notNull(),
  text: text("text").notNull(),
  status: text("status").notNull(),
  inputVersion: integer("input_version"),
  responseJson: text("response_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
}, (table) => [
  uniqueIndex("requests_session_request_uq").on(table.sessionId, table.requestId),
  index("requests_session_created_idx").on(table.sessionId, table.createdAt),
  index("requests_created_idx").on(table.createdAt),
]);

export const memorySettings = sqliteTable("memory_settings", {
  userId: text("user_id").primaryKey(),
  enabled: integer("enabled").notNull().default(0),
  version: integer("version").notNull().default(0),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

export const habitMemories = sqliteTable("habit_memories", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull(),
  kind: text("kind").notNull(),
  valueJson: text("value_json").notNull(),
  sourceSessionId: text("source_session_id").notNull(),
  sourceTurn: integer("source_turn").notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [
  uniqueIndex("habit_memories_user_kind_uq").on(table.userId, table.kind),
  index("habit_memories_user_expires_idx").on(table.userId, table.expiresAt),
]);
