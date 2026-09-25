import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const sessions = sqliteTable("sessions", {
  id: text("id").primaryKey(),
  stateJson: text("state_json").notNull(),
  inputVersion: integer("input_version").notNull().default(0),
  stateVersion: integer("state_version").notNull().default(0),
  resultJson: text("result_json"),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
  expiresAt: integer("expires_at").notNull(),
}, (table) => [index("sessions_expires_idx").on(table.expiresAt)]);

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
