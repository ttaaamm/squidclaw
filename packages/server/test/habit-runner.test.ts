import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, registerNode, Journal } from "@squidclaw/kernel";
import { Agent, FlowStore, VibeState, DEFAULT_VIBES } from "@squidclaw/agent";
import { ReflexStore } from "@squidclaw/reflexes";
import { habitRunner, type Booted } from "./../src/boot.js";

function booted(): Booted {
  const dir = mkdtempSync(join(tmpdir(), "runner-"));
  const flows = new FlowStore(join(dir, "flows"));
  const journal = new Journal(":memory:");
  flows.saveDraft({
    name: "fetch-it", description: "fetches", signature: "flaky.node", triggers: [], params: [],
    runs: 2, createdAt: "now", status: "draft",
    graph: { nodes: [{ id: "n1", node: "flaky.node", params: {} }], edges: [] },
  });
  flows.promote("fetch-it");
  return {
    flows,
    reflexes: new ReflexStore(join(dir, "reflexes")),
    journal,
    vibes: new VibeState(DEFAULT_VIBES),
    agent: new Agent({ brains: null as never, journal, tenantId: "dev", innerMe: "", flows }),
    workspace: dir,
    via: "cli",
    mcp: { registered: [], failed: {} },
  };
}

describe("running a habit, with healing around it", () => {
  beforeEach(clearNodes);

  it("returns the result when the habit simply works", async () => {
    registerNode({ name: "flaky.node", description: "", inputSchema: {}, run: async () => [{ json: { ok: 1 } }] });
    const ctx = booted();
    ctx.agent.registerHabits();
    const out = await habitRunner(ctx, () => {})("fetch-it", {});
    expect(out).toEqual([{ json: { ok: 1 } }]);
  });

  it("says so plainly when the habit doesn't exist", async () => {
    await expect(habitRunner(booted(), () => {})("imaginary", {})).rejects.toThrow(/no promoted habit called/);
  });

  /**
   * Regression: a retry that throws must be reported as a failed run, not
   * allowed to escape. When it escaped, healing stopped after one attempt and
   * nobody was ever told — the failure mode that matters most at 3am.
   */
  it("keeps retrying transient failures and tells a human when it gives up", async () => {
    let attempts = 0;
    registerNode({
      name: "flaky.node", description: "", inputSchema: {},
      run: async () => {
        attempts++;
        throw new Error("fetch failed");
      },
    });
    const told: string[] = [];
    const ctx = booted();
    ctx.agent.registerHabits();

    await expect(habitRunner(ctx, (m) => void told.push(m))("fetch-it", {})).rejects.toThrow(/fetch failed/);

    expect(attempts).toBe(4); // the original try, then three retries
    expect(told).toHaveLength(1);
    expect(told[0]).toContain('habit "fetch-it"');
    expect(told[0]).toContain("Tried 3 times");
  }, 30_000);

  it("recovers silently-ish when a retry succeeds, and says it recovered", async () => {
    let attempts = 0;
    registerNode({
      name: "flaky.node", description: "", inputSchema: {},
      run: async () => {
        if (++attempts === 1) throw new Error("ECONNRESET");
        return [{ json: { recovered: true } }];
      },
    });
    const told: string[] = [];
    const ctx = booted();
    ctx.agent.registerHabits();

    const out = await habitRunner(ctx, (m) => void told.push(m))("fetch-it", {});
    expect(out).toEqual([{ json: { recovered: true } }]);
    expect(told.join(" ")).toContain("recovered after 1 retry");
  }, 30_000);

  it("never retries a broken habit — it escalates at once", async () => {
    let attempts = 0;
    registerNode({
      name: "flaky.node", description: "", inputSchema: {},
      run: async () => {
        attempts++;
        throw new Error("HTTP 404");
      },
    });
    const told: string[] = [];
    const ctx = booted();
    ctx.agent.registerHabits();

    await expect(habitRunner(ctx, (m) => void told.push(m))("fetch-it", {})).rejects.toThrow();
    expect(attempts).toBe(1);
    expect(told[0]).toContain("couldn't fix this myself");
  });
});
