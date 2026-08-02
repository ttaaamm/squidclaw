import Database from "better-sqlite3";
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
  private db: Database.Database;

  constructor(
    dbPath: string,
    private maxTurns = 20,
  ) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id TEXT NOT NULL, chat_id TEXT NOT NULL,
        role TEXT NOT NULL, content TEXT NOT NULL, at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS turns_scope ON turns (tenant_id, chat_id, id);`);
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
      .all(tenantId, chatId, this.maxTurns) as Turn[];
    return rows.reverse();
  }

  forget(tenantId: string, chatId: string): void {
    this.db.prepare(`DELETE FROM turns WHERE tenant_id = ? AND chat_id = ?`).run(tenantId, chatId);
  }

  close(): void {
    this.db.close();
  }
}
