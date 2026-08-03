import Database from "better-sqlite3";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { safeEqual } from "./vault.js";

export interface Quotas {
  /** Improvised runs per day — the expensive kind. */
  thoughtsPerDay: number;
  /** Habit runs per day — cheap, so the ceiling is higher. */
  habitsPerDay: number;
  /** Habits a tenant may keep. */
  maxHabits: number;
}

export const PLANS: Record<string, Quotas> = {
  trial: { thoughtsPerDay: 50, habitsPerDay: 500, maxHabits: 5 },
  standard: { thoughtsPerDay: 500, habitsPerDay: 10_000, maxHabits: 50 },
  unlimited: { thoughtsPerDay: Infinity, habitsPerDay: Infinity, maxHabits: Infinity },
};

export interface Tenant {
  id: string;
  name: string;
  plan: keyof typeof PLANS | string;
  token: string;
  enabled: boolean;
  createdAt: string;
}

/** Which conversation belongs to whom. One tenant may have many. */
export interface Binding {
  surface: string;
  chatId: string;
  tenantId: string;
}

export class TenantStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tenants (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, plan TEXT NOT NULL,
        token TEXT NOT NULL UNIQUE, enabled INTEGER NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS bindings (
        surface TEXT NOT NULL, chat_id TEXT NOT NULL, tenant_id TEXT NOT NULL,
        PRIMARY KEY (surface, chat_id));
      CREATE TABLE IF NOT EXISTS usage (
        tenant_id TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL,
        count INTEGER NOT NULL, PRIMARY KEY (tenant_id, day, kind));`);
  }

  private row(r: Record<string, unknown> | undefined): Tenant | undefined {
    if (!r) return undefined;
    return {
      id: r.id as string, name: r.name as string, plan: r.plan as string,
      token: r.token as string, enabled: !!r.enabled, createdAt: r.created_at as string,
    };
  }

  create(name: string, plan: keyof typeof PLANS = "trial"): Tenant {
    const tenant: Tenant = {
      id: randomUUID().slice(0, 8),
      name,
      plan,
      token: randomBytes(24).toString("base64url"),
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.db
      .prepare(`INSERT INTO tenants VALUES (?,?,?,?,1,?)`)
      .run(tenant.id, tenant.name, tenant.plan, tenant.token, tenant.createdAt);
    return tenant;
  }

  all(): Tenant[] {
    return (this.db.prepare(`SELECT * FROM tenants ORDER BY created_at`).all() as Record<string, unknown>[])
      .map((r) => this.row(r)!)
      .filter(Boolean);
  }

  find(id: string): Tenant | undefined {
    return this.row(this.db.prepare(`SELECT * FROM tenants WHERE id = ?`).get(id) as Record<string, unknown>);
  }

  /** Constant-time match, so a token can't be guessed a character at a time. */
  byToken(token: string): Tenant | undefined {
    if (!token) return undefined;
    return this.all().find((t) => t.enabled && safeEqual(t.token, token));
  }

  setEnabled(id: string, enabled: boolean): boolean {
    return this.db.prepare(`UPDATE tenants SET enabled = ? WHERE id = ?`).run(enabled ? 1 : 0, id).changes > 0;
  }

  setPlan(id: string, plan: string): boolean {
    return this.db.prepare(`UPDATE tenants SET plan = ? WHERE id = ?`).run(plan, id).changes > 0;
  }

  quotas(id: string): Quotas {
    const tenant = this.find(id);
    return PLANS[tenant?.plan ?? "trial"] ?? PLANS.trial;
  }

  bind(surface: string, chatId: string, tenantId: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO bindings VALUES (?,?,?)`)
      .run(surface, chatId, tenantId);
  }

  tenantFor(surface: string, chatId: string): Tenant | undefined {
    const row = this.db
      .prepare(`SELECT tenant_id FROM bindings WHERE surface = ? AND chat_id = ?`)
      .get(surface, chatId) as { tenant_id: string } | undefined;
    return row ? this.find(row.tenant_id) : undefined;
  }

  bindings(tenantId: string): Binding[] {
    return (
      this.db.prepare(`SELECT * FROM bindings WHERE tenant_id = ?`).all(tenantId) as Record<string, string>[]
    ).map((r) => ({ surface: r.surface, chatId: r.chat_id, tenantId: r.tenant_id }));
  }

  // --- usage ---------------------------------------------------------------

  private today(): string {
    return new Date().toISOString().slice(0, 10);
  }

  record(tenantId: string, kind: "thought" | "habit", day = this.today()): void {
    this.db
      .prepare(
        `INSERT INTO usage VALUES (?,?,?,1)
         ON CONFLICT(tenant_id, day, kind) DO UPDATE SET count = count + 1`,
      )
      .run(tenantId, day, kind);
  }

  used(tenantId: string, kind: "thought" | "habit", day = this.today()): number {
    const row = this.db
      .prepare(`SELECT count FROM usage WHERE tenant_id = ? AND day = ? AND kind = ?`)
      .get(tenantId, day, kind) as { count: number } | undefined;
    return row?.count ?? 0;
  }

  /** Null when allowed; a human-readable reason when not. */
  checkQuota(tenantId: string, kind: "thought" | "habit"): string | null {
    const tenant = this.find(tenantId);
    if (!tenant) return "unknown tenant";
    if (!tenant.enabled) return "this account is disabled";

    const quotas = this.quotas(tenantId);
    const limit = kind === "thought" ? quotas.thoughtsPerDay : quotas.habitsPerDay;
    if (this.used(tenantId, kind) >= limit) {
      return kind === "thought"
        ? `you've used today's ${limit} thinking runs on the ${tenant.plan} plan — habits still run free`
        : `you've used today's ${limit} habit runs on the ${tenant.plan} plan`;
    }
    return null;
  }

  close(): void {
    this.db.close();
  }
}
