import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Turn {
  role: "user" | "assistant";
  content: string;
  at: string;
}

/**
 * Episodic memory: what was just said.
 *
 * Scoped by tenant + chat, so two clients — or two chats of one client —
 * never bleed into each other.
 */
export class ConversationStore {
  private db: DatabaseSync;

  constructor(
    dbPath: string,
    private maxTurns = 20,
  ) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL, chat_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS turns_scope ON turns (tenant_id, chat_id, id);
      CREATE TABLE IF NOT EXISTS summaries (
        tenant_id TEXT NOT NULL, chat_id TEXT NOT NULL,
        summary TEXT NOT NULL, turns_covered INTEGER NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY (tenant_id, chat_id));`);
  }

  append(tenantId: string, chatId: string, role: Turn["role"], content: string): void {
    this.db
      .prepare(`INSERT INTO turns (tenant_id, chat_id, role, content, at) VALUES (?,?,?,?,?)`)
      .run(tenantId, chatId, role, content, new Date().toISOString());
  }

  /** Most recent turns, oldest first — ready to prepend to a prompt. */
  recent(tenantId: string, chatId: string): Turn[] {
    const rows = this.db
      .prepare(
        `SELECT role, content, at FROM turns
         WHERE tenant_id = ? AND chat_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(tenantId, chatId, this.maxTurns) as unknown as Turn[];
    return rows.reverse();
  }

  count(tenantId: string, chatId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM turns WHERE tenant_id = ? AND chat_id = ?`)
      .get(tenantId, chatId) as { c: number };
    return Number(row.c);
  }

  /**
   * The rolling summary: what the chat was about before the recent window.
   * The recent turns travel verbatim; everything older lives here, compressed.
   */
  summary(tenantId: string, chatId: string): { summary: string; turnsCovered: number } | undefined {
    const row = this.db
      .prepare(`SELECT summary, turns_covered FROM summaries WHERE tenant_id = ? AND chat_id = ?`)
      .get(tenantId, chatId) as { summary: string; turns_covered: number } | undefined;
    return row ? { summary: row.summary, turnsCovered: Number(row.turns_covered) } : undefined;
  }

  setSummary(tenantId: string, chatId: string, summary: string, turnsCovered: number): void {
    this.db
      .prepare(
        `INSERT INTO summaries VALUES (?,?,?,?,?)
         ON CONFLICT(tenant_id, chat_id) DO UPDATE SET
           summary = excluded.summary, turns_covered = excluded.turns_covered, updated_at = excluded.updated_at`,
      )
      .run(tenantId, chatId, summary, turnsCovered, new Date().toISOString());
  }

  /** Turns between the summarized horizon and the recent window — what needs folding in. */
  turnsBetween(tenantId: string, chatId: string, fromCount: number, toCount: number): Turn[] {
    const rows = this.db
      .prepare(
        `SELECT role, content, at FROM turns WHERE tenant_id = ? AND chat_id = ?
         ORDER BY id LIMIT ? OFFSET ?`,
      )
      .all(tenantId, chatId, Math.max(0, toCount - fromCount), fromCount) as unknown as Turn[];
    return rows;
  }

  forget(tenantId: string, chatId: string): void {
    this.db.prepare(`DELETE FROM turns WHERE tenant_id = ? AND chat_id = ?`).run(tenantId, chatId);
    this.db.prepare(`DELETE FROM summaries WHERE tenant_id = ? AND chat_id = ?`).run(tenantId, chatId);
  }

  close(): void {
    this.db.close();
  }
}
