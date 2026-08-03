import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { TenantStore, Vault, AgentPool, safeEqual, PLANS } from "@squidclaw/tenants";

const dir = () => mkdtempSync(join(tmpdir(), "tenant-"));

describe("tenant registry", () => {
  let store: TenantStore;
  beforeEach(() => {
    store = new TenantStore(":memory:");
  });

  it("creates tenants with distinct ids and unguessable tokens", () => {
    const a = store.create("Al Jood", "standard");
    const b = store.create("Saudi Times");
    expect(a.id).not.toBe(b.id);
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(32);
    expect(a.plan).toBe("standard");
    expect(b.plan).toBe("trial");
    expect(store.all()).toHaveLength(2);
  });

  it("finds a tenant by token, and refuses a disabled one", () => {
    const t = store.create("Al Jood");
    expect(store.byToken(t.token)?.id).toBe(t.id);
    expect(store.byToken("wrong")).toBeUndefined();
    expect(store.byToken("")).toBeUndefined();

    store.setEnabled(t.id, false);
    expect(store.byToken(t.token)).toBeUndefined();
  });

  it("binds conversations to tenants, and keeps surfaces apart", () => {
    const a = store.create("A");
    const b = store.create("B");
    store.bind("telegram", "111", a.id);
    store.bind("whatsapp", "111", b.id);

    expect(store.tenantFor("telegram", "111")?.id).toBe(a.id);
    expect(store.tenantFor("whatsapp", "111")?.id).toBe(b.id);
    expect(store.tenantFor("telegram", "999")).toBeUndefined();
    expect(store.bindings(a.id)).toEqual([{ surface: "telegram", chatId: "111", tenantId: a.id }]);
  });

  it("re-binding a chat moves it rather than duplicating it", () => {
    const a = store.create("A");
    const b = store.create("B");
    store.bind("telegram", "111", a.id);
    store.bind("telegram", "111", b.id);
    expect(store.tenantFor("telegram", "111")?.id).toBe(b.id);
    expect(store.bindings(a.id)).toEqual([]);
  });
});

describe("quotas", () => {
  let store: TenantStore;
  beforeEach(() => {
    store = new TenantStore(":memory:");
  });

  it("counts thinking and habit runs separately", () => {
    const t = store.create("A");
    store.record(t.id, "thought");
    store.record(t.id, "thought");
    store.record(t.id, "habit");
    expect(store.used(t.id, "thought")).toBe(2);
    expect(store.used(t.id, "habit")).toBe(1);
  });

  it("stops a trial tenant at its thinking limit but lets habits keep running", () => {
    const t = store.create("A", "trial");
    for (let i = 0; i < PLANS.trial.thoughtsPerDay; i++) store.record(t.id, "thought");

    const denied = store.checkQuota(t.id, "thought");
    expect(denied).toContain("thinking runs");
    expect(denied).toContain("habits still run free");
    expect(store.checkQuota(t.id, "habit")).toBeNull();
  });

  it("never limits the unlimited plan", () => {
    const t = store.create("A", "unlimited");
    for (let i = 0; i < 1000; i++) store.record(t.id, "thought");
    expect(store.checkQuota(t.id, "thought")).toBeNull();
  });

  it("refuses unknown and disabled tenants", () => {
    expect(store.checkQuota("ghost", "thought")).toBe("unknown tenant");
    const t = store.create("A");
    store.setEnabled(t.id, false);
    expect(store.checkQuota(t.id, "thought")).toContain("disabled");
  });

  it("counts per day, so yesterday's usage doesn't spend today's budget", () => {
    const t = store.create("A", "trial");
    for (let i = 0; i < PLANS.trial.thoughtsPerDay; i++) store.record(t.id, "thought", "2026-08-02");
    expect(store.checkQuota(t.id, "thought")).toBeNull();
  });
});

describe("the vault", () => {
  it("seals and opens a secret", () => {
    const v = new Vault(dir(), "a-long-enough-master-key");
    v.put("t1", "stripe", "sk_live_abc123");
    expect(v.get("t1", "stripe")).toBe("sk_live_abc123");
    expect(v.names("t1")).toEqual(["stripe"]);
  });

  it("never writes a secret in the clear", () => {
    const d = dir();
    const v = new Vault(d, "a-long-enough-master-key");
    v.put("t1", "stripe", "sk_live_abc123");
    const onDisk = readFileSync(join(d, "t1.vault.json"), "utf8");
    expect(onDisk).not.toContain("sk_live_abc123");
    expect(onDisk).toContain("iv");
  });

  it("keeps tenants' secrets apart", () => {
    const v = new Vault(dir(), "a-long-enough-master-key");
    v.put("t1", "key", "mine");
    v.put("t2", "key", "yours");
    expect(v.get("t1", "key")).toBe("mine");
    expect(v.get("t2", "key")).toBe("yours");
    expect(v.get("t3", "key")).toBeUndefined();
  });

  it("cannot be opened with the wrong master key", () => {
    const d = dir();
    new Vault(d, "the-correct-master-key").put("t1", "k", "secret");
    expect(() => new Vault(d, "a-different-master-key").get("t1", "k")).toThrow();
  });

  it("refuses a master key too short to be worth anything", () => {
    expect(() => new Vault(dir(), "short")).toThrow(/at least 16/);
  });

  it("removes secrets", () => {
    const v = new Vault(dir(), "a-long-enough-master-key");
    v.put("t1", "k", "v");
    expect(v.remove("t1", "k")).toBe(true);
    expect(v.get("t1", "k")).toBeUndefined();
    expect(v.remove("t1", "k")).toBe(false);
  });
});

describe("constant-time comparison", () => {
  it("matches equal strings and rejects everything else", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "")).toBe(true);
  });
});

describe("the agent pool", () => {
  it("builds one organism per tenant, in its own directory, and keeps it warm", async () => {
    const store = new TenantStore(":memory:");
    const a = store.create("A");
    const b = store.create("B");
    const built: string[] = [];

    const pool = new AgentPool(store, "/agents", (ws) => {
      built.push(ws.dir);
      return { dir: ws.dir };
    });

    const first = await pool.for(a.id);
    const again = await pool.for(a.id);
    expect(again).toBe(first); // kept warm, not rebuilt
    expect(built).toHaveLength(1);

    const other = await pool.for(b.id);
    expect(other).not.toBe(first);
    expect(first.dir).toContain(a.id);
    expect(other.dir).toContain(b.id);
    expect(pool.size()).toBe(2);
  });

  it("refuses unknown and disabled tenants", async () => {
    const store = new TenantStore(":memory:");
    const t = store.create("A");
    const pool = new AgentPool(store, "/agents", () => ({}));

    await expect(pool.for("ghost")).rejects.toThrow(/unknown tenant/);
    store.setEnabled(t.id, false);
    await expect(pool.for(t.id)).rejects.toThrow(/disabled/);
  });

  it("rebuilds after eviction, so a plan change takes effect", async () => {
    const store = new TenantStore(":memory:");
    const t = store.create("A");
    let builds = 0;
    const pool = new AgentPool(store, "/agents", () => ({ n: ++builds }));

    await pool.for(t.id);
    pool.evict(t.id);
    await pool.for(t.id);
    expect(builds).toBe(2);
  });
});
