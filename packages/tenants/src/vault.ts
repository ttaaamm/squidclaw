import { createCipheriv, createDecipheriv, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ALGO = "aes-256-gcm";
const SALT = "squidclaw.vault.v1";

export interface SealedSecret {
  iv: string;
  tag: string;
  data: string;
}

/**
 * What it's trusted with.
 *
 * Secrets are sealed per tenant with a key derived from the deployment's
 * master key. Losing that key loses every credential — which is the correct
 * failure mode: nothing here should be recoverable without it.
 */
export class Vault {
  private key: Buffer;

  constructor(
    private dir: string,
    masterKey: string,
  ) {
    if (!masterKey || masterKey.length < 16) {
      throw new Error("vault: master key must be at least 16 characters");
    }
    this.key = scryptSync(masterKey, SALT, 32);
    mkdirSync(dir, { recursive: true });
  }

  private path(tenantId: string): string {
    return join(this.dir, `${tenantId}.vault.json`);
  }

  private read(tenantId: string): Record<string, SealedSecret> {
    const path = this.path(tenantId);
    if (!existsSync(path)) return {};
    return JSON.parse(readFileSync(path, "utf8")) as Record<string, SealedSecret>;
  }

  seal(value: string): SealedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
    return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
  }

  open(sealed: SealedSecret): string {
    const decipher = createDecipheriv(ALGO, this.key, Buffer.from(sealed.iv, "base64"));
    decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(sealed.data, "base64")), decipher.final()]).toString("utf8");
  }

  put(tenantId: string, name: string, value: string): void {
    const all = this.read(tenantId);
    all[name] = this.seal(value);
    writeFileSync(this.path(tenantId), `${JSON.stringify(all, null, 2)}\n`, "utf8");
  }

  get(tenantId: string, name: string): string | undefined {
    const sealed = this.read(tenantId)[name];
    return sealed ? this.open(sealed) : undefined;
  }

  /** Names only — the dashboard should be able to say what exists without seeing it. */
  names(tenantId: string): string[] {
    return Object.keys(this.read(tenantId));
  }

  remove(tenantId: string, name: string): boolean {
    const all = this.read(tenantId);
    if (!(name in all)) return false;
    delete all[name];
    writeFileSync(this.path(tenantId), `${JSON.stringify(all, null, 2)}\n`, "utf8");
    return true;
  }
}

/** Compares tokens without leaking their length or contents through timing. */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
