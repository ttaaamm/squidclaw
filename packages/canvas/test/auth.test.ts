import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "@squidclaw/kernel";
import { FlowStore } from "@squidclaw/agent";
import { ReflexStore } from "@squidclaw/reflexes";
import { DashboardServer, type Sources } from "@squidclaw/canvas";

const TOKEN = "a-secret-dashboard-token";

describe("a guarded mind", () => {
  let server: DashboardServer;
  let port: number;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "auth-"));
    const src: Sources = {
      journal: new Journal(":memory:"),
      flows: new FlowStore(join(dir, "flows")),
      reflexes: new ReflexStore(join(dir, "reflexes")),
      mind: { via: "cli", tools: 1 },
      tenantId: "dev",
    };
    server = new DashboardServer(src, { token: TOKEN, pollMs: 10_000 });
    port = await server.listen(0);
  });

  afterEach(async () => server.close());

  const get = (path: string, headers: Record<string, string> = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: "manual" });

  it("turns away anyone without the token — page and API alike", async () => {
    for (const path of ["/", "/api/state", "/api/executions", "/api/events"]) {
      const res = await get(path);
      expect(res.status).toBe(401);
      expect(await res.text()).toContain("private");
    }
  });

  it("rejects a wrong token", async () => {
    expect((await get(`/api/state?token=not-it`)).status).toBe(401);
  });

  it("lets the right token in, and hands back a cookie so the page's own calls work", async () => {
    const res = await get(`/?token=${TOKEN}`);
    expect(res.status).toBe(200);
    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("sc_token=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const api = await get("/api/state", { cookie: `sc_token=${encodeURIComponent(TOKEN)}` });
    expect(api.status).toBe(200);
    expect((await api.json()).mind.via).toBe("cli");
  });

  it("does not leak a hint about the token's length through a partial match", async () => {
    expect((await get(`/api/state?token=${TOKEN.slice(0, -1)}`)).status).toBe(401);
    expect((await get(`/api/state?token=${TOKEN}x`)).status).toBe(401);
  });

  it("stays open when no token is configured — localhost dev should stay frictionless", async () => {
    const dir = mkdtempSync(join(tmpdir(), "open-"));
    const open = new DashboardServer(
      {
        journal: new Journal(":memory:"),
        flows: new FlowStore(join(dir, "flows")),
        reflexes: new ReflexStore(join(dir, "reflexes")),
        mind: { via: "cli", tools: 1 },
      },
      { pollMs: 10_000 },
    );
    const p = await open.listen(0);
    expect((await fetch(`http://127.0.0.1:${p}/api/state`)).status).toBe(200);
    await open.close();
  });
});
