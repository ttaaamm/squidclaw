import { DatabaseSync } from "node:sqlite";
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Per-tenant credential store.
 *
 * Every user's Flywheel keeps its own keys — OpenAI, Anthropic, Slack, … —
 * encrypted at rest and scoped to their tenant. A node executor asks for a
 * credential by type ("openAiApi") and gets the decrypted fields, or a clear
 * "not configured" so the flow can tell the user exactly what to fill in.
 *
 * Storage: one SQLite file per tenant, under the tenant workspace. Values are
 * AES-256-GCM encrypted with a key derived from SQUIDCLAW_CRED_SECRET, so the
 * DB on disk never holds a plaintext key.
 */

const WORKSPACE = process.env.SQUIDCLAW_WORKSPACE ?? "workspace";

function keyFromSecret(): Buffer {
  const secret = process.env.SQUIDCLAW_CRED_SECRET;
  if (!secret) throw new Error("SQUIDCLAW_CRED_SECRET is not set — cannot encrypt/decrypt credentials");
  // 32 bytes for AES-256, deterministically derived from the secret.
  return createHash("sha256").update(secret).digest();
}

function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFromSecret(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  // iv.tag.ciphertext, all base64 — self-contained, no external key storage.
  return `${iv.toString("base64")}.${tag.toString("base64")}.${enc.toString("base64")}`;
}

function decrypt(blob: string): string {
  const [ivB64, tagB64, dataB64] = blob.split(".");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("credential ciphertext is malformed");
  const decipher = createDecipheriv("aes-256-gcm", keyFromSecret(), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf8");
}

export interface Credential {
  id: string;
  name: string;
  credType: string;
  values: Record<string, string>;
}

const dbs = new Map<string, DatabaseSync>();

function dbFor(tenantId: string): DatabaseSync {
  let db = dbs.get(tenantId);
  if (db) return db;
  const dir = join(WORKSPACE, "tenants", tenantId);
  mkdirSync(dir, { recursive: true });
  db = new DatabaseSync(join(dir, "credentials.db"));
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`
    CREATE TABLE IF NOT EXISTS node_credentials (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      cred_type  TEXT NOT NULL,
      encrypted  TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cred_by_type ON node_credentials (cred_type);`);
  dbs.set(tenantId, db);
  return db;
}

export const credentialStore = {
  create(tenantId: string, name: string, credType: string, values: Record<string, string>): string {
    const db = dbFor(tenantId);
    const id = `cred_${randomBytes(9).toString("base64url")}`;
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO node_credentials (id, name, cred_type, encrypted, created_at, updated_at) VALUES (?,?,?,?,?,?)`,
    ).run(id, name, credType, encrypt(JSON.stringify(values)), now, now);
    return id;
  },

  list(tenantId: string): Omit<Credential, "values">[] {
    const rows = dbFor(tenantId)
      .prepare(`SELECT id, name, cred_type FROM node_credentials ORDER BY created_at DESC`)
      .all() as Array<{ id: string; name: string; cred_type: string }>;
    return rows.map((r) => ({ id: r.id, name: r.name, credType: r.cred_type }));
  },

  delete(tenantId: string, id: string): void {
    dbFor(tenantId).prepare(`DELETE FROM node_credentials WHERE id = ?`).run(id);
  },

  /** First credential of a given type, decrypted. undefined if none — the flow then knows to ask. */
  resolve(tenantId: string, credType: string): Credential | undefined {
    const row = dbFor(tenantId)
      .prepare(`SELECT id, name, cred_type, encrypted FROM node_credentials WHERE cred_type = ? ORDER BY created_at LIMIT 1`)
      .get(credType) as { id: string; name: string; cred_type: string; encrypted: string } | undefined;
    if (!row) return undefined;
    return { id: row.id, name: row.name, credType: row.cred_type, values: JSON.parse(decrypt(row.encrypted)) };
  },

  /** Which credential types a set of node types require, and whether the tenant has each — powers the import checklist. */
  gaps(tenantId: string, requiredTypes: string[]): Array<{ credType: string; present: boolean }> {
    return [...new Set(requiredTypes)].map((t) => ({ credType: t, present: !!this.resolve(tenantId, t) }));
  },
};
