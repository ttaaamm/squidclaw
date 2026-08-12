import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "@squidclaw/kernel";
import { FlowStore } from "@squidclaw/agent";
import { ReflexStore } from "@squidclaw/reflexes";
import { DashboardServer, type Sources } from "@squidclaw/canvas";

const TOKEN = "write-token";

const flowBody = (name: string, over: Record<string, unknown> = {}) => ({
  name,
  description: "posts the news",
  graph: {
    nodes: [{ id: "a", node: "web.search", params: { query: "ai" } }],
    edges: [],
  },
  ...over,
});

describe("writing flows through the canvas", () => {
  let server: DashboardServer;
  let port: number;
  let flows: FlowStore;
  let ran: Array<{ tenantId?: string; name: string; args: Record<string, unknown> }>;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowwrite-"));
    flows = new FlowStore(join(dir, "flows"));
    const src: Sources = {
      journal: new Journal(":memory:"),
      flows,
      reflexes: new ReflexStore(join(dir, "reflexes")),
      mind: { via: "cli", tools: 1 },
      tenantId: "dev",
    };
    ran = [];
    server = new DashboardServer(src, {
      token: TOKEN,
      pollMs: 10_000,
      run: async (tenantId, name, args) => {
        ran.push({ tenantId, name, args });
        return { posted: true };
      },
    });
    port = await server.listen(0);
  });

  afterEach(async () => server.close());

  const call = (path: string, init: RequestInit = {}) =>
    fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      headers: { cookie: `sc_token=${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
      redirect: "manual",
    });

  it("creates a flow, and it lands as a draft rather than armed", async () => {
    const res = await call("/api/habits", { method: "POST", body: JSON.stringify(flowBody("morning-news")) });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ ok: true, name: "morning-news", status: "draft" });

    const saved = flows.find("morning-news")!;
    expect(saved.status).toBe("draft");
    expect(saved.graph.nodes).toHaveLength(1);
    // Never promoted by the act of saving -- arming stays a separate decision.
    expect(flows.promoted()).toHaveLength(0);
  });

  it("refuses a name that could climb out of the flows directory", async () => {
    for (const name of ["../escape", "../../etc/passwd", "a/b", "with space", ""]) {
      const res = await call("/api/habits", { method: "POST", body: JSON.stringify(flowBody(name)) });
      expect(res.status, `name ${JSON.stringify(name)} should be refused`).toBe(400);
    }
    expect(flows.all()).toHaveLength(0);
  });

  it("refuses a body with no usable graph", async () => {
    const res = await call("/api/habits", {
      method: "POST",
      body: JSON.stringify({ name: "broken", description: "no graph" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("graph.nodes");
  });

  it("will not silently overwrite an existing flow", async () => {
    await call("/api/habits", { method: "POST", body: JSON.stringify(flowBody("dup")) });
    const again = await call("/api/habits", { method: "POST", body: JSON.stringify(flowBody("dup")) });
    expect(again.status).toBe(409);
  });

  it("edits an existing flow in place", async () => {
    await call("/api/habits", { method: "POST", body: JSON.stringify(flowBody("editable")) });
    const res = await call("/api/habits/editable", {
      method: "PATCH",
      body: JSON.stringify({ description: "now it posts twice" }),
    });
    expect(res.status).toBe(200);
    expect(flows.find("editable")!.description).toBe("now it posts twice");
  });

  it("keeps a promoted flow promoted when it is edited", async () => {
    await call("/api/habits", { method: "POST", body: JSON.stringify(flowBody("live")) });
    expect((await call("/api/habits/live/promote", { method: "POST" })).status).toBe(200);
    expect(flows.find("live")!.status).toBe("promoted");

    await call("/api/habits/live", { method: "PATCH", body: JSON.stringify({ description: "fixed" }) });
    const after = flows.find("live")!;
    expect(after.description).toBe("fixed");
    // A human fixing a live flow should not have to re-arm it.
    expect(after.status).toBe("promoted");
  });

  it("deletes a flow, and says so honestly when there was nothing to delete", async () => {
    await call("/api/habits", { method: "POST", body: JSON.stringify(flowBody("doomed")) });
    expect((await call("/api/habits/doomed", { method: "DELETE" })).status).toBe(200);
    expect(flows.find("doomed")).toBeUndefined();
    expect((await call("/api/habits/doomed", { method: "DELETE" })).status).toBe(404);
  });

  it("refreshes the agent after every write, so a promoted flow is runnable at once", async () => {
    // Regression: habits are registered into a Map when an organism boots, so
    // without a refresh a flow promoted here stayed unrunnable until restart.
    const seen: Array<string | undefined> = [];
    const dir = mkdtempSync(join(tmpdir(), "refresh-"));
    const store = new FlowStore(join(dir, "flows"));
    const s = new DashboardServer(
      {
        journal: new Journal(":memory:"), flows: store,
        reflexes: new ReflexStore(join(dir, "reflexes")),
        mind: { via: "cli", tools: 1 }, tenantId: "dev",
      },
      { token: TOKEN, pollMs: 10_000, run: async () => ({}), refresh: (t) => void seen.push(t) },
    );
    const p = await s.listen(0);
    const hit = (path: string, init: RequestInit = {}) =>
      fetch(`http://127.0.0.1:${p}${path}`, {
        ...init,
        headers: { cookie: `sc_token=${TOKEN}`, "content-type": "application/json", ...(init.headers ?? {}) },
      });
    try {
      await hit("/api/habits", { method: "POST", body: JSON.stringify(flowBody("fresh")) });
      expect(seen).toHaveLength(1); // create

      await hit("/api/habits/fresh", { method: "PATCH", body: JSON.stringify({ description: "x" }) });
      expect(seen).toHaveLength(2); // edit

      const promoted = await hit("/api/habits/fresh/promote", { method: "POST" });
      expect(promoted.status).toBe(200);
      expect(seen).toHaveLength(3); // promote -- and before the response, not after

      await hit("/api/habits/fresh", { method: "DELETE" });
      expect(seen).toHaveLength(4); // delete
    } finally {
      await s.close();
    }
  });

  it("runs a flow through the injected runner, passing the arguments along", async () => {
    await call("/api/habits", { method: "POST", body: JSON.stringify(flowBody("runnable")) });
    const res = await call("/api/habits/runnable/run", {
      method: "POST",
      body: JSON.stringify({ topic: "ai" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, name: "runnable", result: { posted: true } });
    expect(ran).toEqual([{ tenantId: undefined, name: "runnable", args: { topic: "ai" } }]);
  });

  it("reports a failing run as an error instead of hanging the caller", async () => {
    const dir = mkdtempSync(join(tmpdir(), "flowfail-"));
    const store = new FlowStore(join(dir, "flows"));
    const failing = new DashboardServer(
      {
        journal: new Journal(":memory:"), flows: store,
        reflexes: new ReflexStore(join(dir, "reflexes")),
        mind: { via: "cli", tools: 1 }, tenantId: "dev",
      },
      { token: TOKEN, pollMs: 10_000, run: async () => { throw new Error("no promoted habit called \"x\""); } },
    );
    const p = await failing.listen(0);
    try {
      await fetch(`http://127.0.0.1:${p}/api/habits`, {
        method: "POST",
        headers: { cookie: `sc_token=${TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify(flowBody("x")),
      });
      const res = await fetch(`http://127.0.0.1:${p}/api/habits/x/run`, {
        method: "POST", headers: { cookie: `sc_token=${TOKEN}` },
      });
      expect(res.status).toBe(500);
      expect((await res.json()).error).toContain("no promoted habit");
    } finally {
      await failing.close();
    }
  });

  it("answers 404 for actions on a habit that does not exist", async () => {
    expect((await call("/api/habits/ghost/run", { method: "POST" })).status).toBe(404);
    expect((await call("/api/habits/ghost/promote", { method: "POST" })).status).toBe(404);
    expect((await call("/api/habits/ghost", { method: "PATCH", body: "{}" })).status).toBe(404);
  });

  it("still refuses everything without the token", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/habits`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(flowBody("sneaky")),
    });
    expect(res.status).toBe(401);
    expect(flows.all()).toHaveLength(0);
  });

  it("rejects an unsupported verb on a habit", async () => {
    await call("/api/habits", { method: "POST", body: JSON.stringify(flowBody("verbs")) });
    expect((await call("/api/habits/verbs", { method: "PUT", body: "{}" })).status).toBe(405);
  });
});
