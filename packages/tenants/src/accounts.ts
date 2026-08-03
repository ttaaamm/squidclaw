import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CODE_TTL_MS = 10 * 60_000; // a login link is an invitation, not a key
const SESSION_TTL_MS = 30 * 86_400_000;

/**
 * Sign-in without passwords.
 *
 * The platform never stores a password: identity comes from somewhere that
 * already knows the human — their bound chat, or their Preplix account — and
 * is carried here as a one-time code exchanged for a session cookie.
 */
export class LoginStore {
  private db: DatabaseSync;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS login_codes (
        code TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS sessions (
        sid TEXT PRIMARY KEY, tenant_id TEXT NOT NULL, expires_at INTEGER NOT NULL);`);
  }

  /** A one-time code: ten minutes, single use. */
  mintCode(tenantId: string): string {
    const code = randomBytes(20).toString("base64url");
    this.db
      .prepare(`INSERT INTO login_codes VALUES (?,?,?)`)
      .run(code, tenantId, Date.now() + CODE_TTL_MS);
    return code;
  }

  /** Burns the code — a link that worked once must never work twice. */
  redeemCode(code: string): string | undefined {
    const row = this.db
      .prepare(`SELECT tenant_id, expires_at FROM login_codes WHERE code = ?`)
      .get(code) as { tenant_id: string; expires_at: number } | undefined;
    if (row) this.db.prepare(`DELETE FROM login_codes WHERE code = ?`).run(code);
    if (!row || Number(row.expires_at) < Date.now()) return undefined;
    return row.tenant_id;
  }

  createSession(tenantId: string): string {
    const sid = randomBytes(24).toString("base64url");
    this.db.prepare(`INSERT INTO sessions VALUES (?,?,?)`).run(sid, tenantId, Date.now() + SESSION_TTL_MS);
    return sid;
  }

  sessionTenant(sid: string): string | undefined {
    const row = this.db
      .prepare(`SELECT tenant_id, expires_at FROM sessions WHERE sid = ?`)
      .get(sid) as { tenant_id: string; expires_at: number } | undefined;
    if (!row) return undefined;
    if (Number(row.expires_at) < Date.now()) {
      this.db.prepare(`DELETE FROM sessions WHERE sid = ?`).run(sid);
      return undefined;
    }
    return row.tenant_id;
  }

  destroySession(sid: string): void {
    this.db.prepare(`DELETE FROM sessions WHERE sid = ?`).run(sid);
  }

  close(): void {
    this.db.close();
  }
}
