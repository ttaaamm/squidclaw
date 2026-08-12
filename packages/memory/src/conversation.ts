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
    // A long real-world gap since the last turn means the human has moved on.
    // Without this, a 15-hour-old unresolved question ("what schema do you
    // want?") gets replayed as if it's still live the moment they say "hi" --
    // the reply answers the ghost of an old thread instead of the greeting
    // actually in front of it. 2h is deliberately generous: short breaks
    // (lunch, a meeting) should still feel continuous.
    private staleAfterMs = 2 * 60 * 60 * 1000,
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

  /**
   * Most recent turns, oldest first — ready to prepend to a prompt.
   *
   * Cuts at the most recent gap (between two turns, or between the last turn
   * and now) that exceeds staleAfterMs -- not just "is the last turn old".
   * Checking only the last turn was the first version of this fix, and it
   * had a hole: the instant ONE new message arrives, the last turn is fresh
   * again, so the *whole* maxTurns window -- including everything from
   * hours or days earlier -- comes back as if it were still live. A single
   * "hi" would reopen an old thread about cloning a repo, Gmail access, and
   * an unrelated news question, all in the same prompt. Scanning for the
   * boundary and slicing there means only the contiguous recent block ever
   * travels verbatim; the rolling summary() still carries the rest.
   */
  recent(tenantId: string, chatId: string): Turn[] {
    const rows = this.db
      .prepare(
        `SELECT role, content, at FROM turns
         WHERE tenant_id = ? AND chat_id = ? ORDER BY id DESC LIMIT ?`,
      )
      .all(tenantId, chatId, this.maxTurns) as unknown as Turn[];
    const turns = rows.reverse();
    if (turns.length === 0) return turns;

    const boundaries = [...turns.map((t) => new Date(t.at).getTime()), Date.now()];
    let cut = 0; // default: no stale gap found, keep the whole window
    for (let i = boundaries.length - 1; i > 0; i--) {
      if (boundaries[i] - boundaries[i - 1] > this.staleAfterMs) {
        cut = i; // turns[i..] is the contiguous recent block; drop everything before it
        break;
      }
    }
    return turns.slice(cut);
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
