import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReflexStore, Scheduler, WebhookServer, type Reflex } from "@squidclaw/reflexes";

const dir = () => mkdtempSync(join(tmpdir(), "reflex-"));

const reflex = (over: Partial<Reflex> = {}): Reflex => ({
  name: "morning-report",
  flow: "daily-summary",
  args: { channel: "telegram" },
  cron: "0 9 * * *",
  enabled: true,
  createdAt: "2026-08-03T00:00:00Z",
  ...over,
});

describe("reflex store", () => {
  let store: ReflexStore;
  beforeEach(() => {
    store = new ReflexStore(dir());
  });

  it("saves, finds, disables and removes", () => {
    store.save(reflex());
    expect(store.all().map((r) => r.name)).toEqual(["morning-report"]);
    expect(store.find("morning-report")?.flow).toBe("daily-summary");

    expect(store.setEnabled("morning-report", false)).toBe(true);
    expect(store.enabled()).toEqual([]);
    expect(store.all()).toHaveLength(1);

    expect(store.remove("morning-report")).toBe(true);
    expect(store.all()).toEqual([]);
    expect(store.remove("gone")).toBe(false);
  });

  it("refuses a reflex with no trigger at all", () => {
    expect(() => store.save(reflex({ cron: undefined, webhook: undefined }))).toThrow(/cron schedule or a webhook/);
  });

  it("rejects a bad schedule when it's saved, not when it should fire", () => {
    expect(() => store.save(reflex({ cron: "not a cron" }))).toThrow();
  });

  it("records how the last run went", () => {
    store.save(reflex());
    store.recordRun("morning-report", "error");
    expect(store.find("morning-report")?.lastStatus).toBe("error");
    expect(store.find("morning-report")?.lastRun).toBeDefined();
  });
});

describe("scheduler", () => {
  it("fires a habit when the clock matches, and not otherwise", async () => {
    const store = new ReflexStore(dir());
    store.save(reflex());
    const ran: Array<{ flow: string; args: Record<string, unknown> }> = [];

    let now = new Date("2026-08-03T08:59:00");
    const scheduler = new Scheduler(store, async (flow, args) => void ran.push({ flow, args }), { now: () => now });

    expect(await scheduler.tick()).toEqual([]);

    now = new Date("2026-08-03T09:00:00");
    const fired = await scheduler.tick();
    expect(fired).toEqual([{ reflex: "morning-report", status: "ok" }]);
    expect(ran).toEqual([{ flow: "daily-summary", args: { channel: "telegram" } }]);
    expect(store.find("morning-report")?.lastStatus).toBe("ok");
  });

  it("never fires twice inside the same minute", async () => {
    const store = new ReflexStore(dir());
    store.save(reflex());
    let count = 0;
    const now = new Date("2026-08-03T09:00:00");
    const scheduler = new Scheduler(store, async () => void count++, { now: () => now });

    await scheduler.tick();
    await scheduler.tick();
    await scheduler.tick();
    expect(count).toBe(1);
  });

  it("skips disabled reflexes", async () => {
    const store = new ReflexStore(dir());
    store.save(reflex({ enabled: false }));
    const now = new Date("2026-08-03T09:00:00");
    const scheduler = new Scheduler(store, async () => undefined, { now: () => now });
    expect(await scheduler.tick()).toEqual([]);
  });

  it("records a failing habit without throwing, so one bad reflex can't stop the rest", async () => {
    const store = new ReflexStore(dir());
    store.save(reflex());
    const now = new Date("2026-08-03T09:00:00");
    const scheduler = new Scheduler(store, async () => {
      throw new Error("habit exploded");
    }, { now: () => now });

    const [result] = await scheduler.tick();
    expect(result.status).toBe("error");
    expect(result.detail).toContain("habit exploded");
    expect(store.find("morning-report")?.lastStatus).toBe("error");
  });
});

describe("webhook server", () => {
  let server: WebhookServer;
  let port: number;
  let store: ReflexStore;
  let ran: Array<{ flow: string; args: Record<string, unknown> }>;

  beforeEach(async () => {
    store = new ReflexStore(dir());
    store.save(reflex({ name: "on-order", flow: "make-invoice", cron: undefined, webhook: "order", args: { source: "web" } }));
    ran = [];
    server = new WebhookServer(store, async (flow, args) => {
      ran.push({ flow, args });
      return { done: true };
    });
    port = await server.listen(0);
  });

  afterEach(async () => server.close());

  const post = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it("fires the habit and merges the body over the reflex's own args", async () => {
    const res = await post("/hooks/order", { customer: "Al Jood", amount: 500 });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, reflex: "on-order" });
    expect(ran).toEqual([{ flow: "make-invoice", args: { source: "web", customer: "Al Jood", amount: 500 } }]);
  });

  it("answers health checks", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("404s an unknown hook and 405s the wrong method", async () => {
    expect((await post("/hooks/nope")).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/hooks/order`)).status).toBe(405);
  });

  it("rejects a body that isn't JSON", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/hooks/order`, { method: "POST", body: "not json" });
    expect(res.status).toBe(400);
  });

  it("reports a failing habit as a 500 rather than hanging", async () => {
    const failing = new WebhookServer(store, async () => {
      throw new Error("gotenberg down");
    });
    const p = await failing.listen(0);
    const res = await fetch(`http://127.0.0.1:${p}/hooks/order`, { method: "POST" });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ ok: false, error: expect.stringContaining("gotenberg down") });
    await failing.close();
  });

  it("guards with a token when one is configured", async () => {
    const guarded = new WebhookServer(store, async () => ({}), { token: "s3cret" });
    const p = await guarded.listen(0);
    expect((await fetch(`http://127.0.0.1:${p}/hooks/order`, { method: "POST" })).status).toBe(401);
    const ok = await fetch(`http://127.0.0.1:${p}/hooks/order`, {
      method: "POST",
      headers: { "x-squidclaw-token": "s3cret" },
    });
    expect(ok.status).toBe(200);
    await guarded.close();
  });
});
