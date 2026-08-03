import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, Journal } from "@squidclaw/kernel";
import { Agent, FlowStore, VibeState, DEFAULT_VIBES, type Flow } from "@squidclaw/agent";
import { ReflexStore } from "@squidclaw/reflexes";
import { SemanticMemory } from "@squidclaw/memory";
import { handleCommand, type Booted } from "./../src/boot.js";

const draft = (name: string): Flow => ({
  name, description: "does a thing", signature: "http.request", triggers: ["do it"],
  params: ["url"], runs: 2, createdAt: "now", status: "draft",
  graph: { nodes: [{ id: "n1", node: "http.request", params: { url: "{{url}}" } }], edges: [] },
});

function booted(): Booted {
  const dir = mkdtempSync(join(tmpdir(), "cmd-"));
  const flows = new FlowStore(join(dir, "flows"));
  const reflexes = new ReflexStore(join(dir, "reflexes"));
  const journal = new Journal(":memory:");
  return {
    flows,
    reflexes,
    journal,
    memory: new SemanticMemory(join(dir, "memory")),
    vibes: new VibeState(DEFAULT_VIBES),
    agent: new Agent({ brains: null as never, journal, tenantId: "dev", innerMe: "", flows }),
    workspace: dir,
    via: "cli",
    mcp: { registered: [], failed: {} },
  };
}

describe("chat commands", () => {
  beforeEach(clearNodes);

  it("passes ordinary messages through to the mind", () => {
    expect(handleCommand("what is the weather?", booted(), "c1")).toBeNull();
  });

  it("reports when there are no habits yet", () => {
    expect(handleCommand("/habits", booted(), "c1")).toContain("still improvising");
  });

  it("lists drafts separately from promoted habits", () => {
    const ctx = booted();
    ctx.flows.saveDraft(draft("fetch-thing"));
    const listed = handleCommand("/habits", ctx, "c1")!;
    expect(listed).toContain("Waiting on your yes");
    expect(listed).toContain("fetch-thing (2 runs, needs url)");
  });

  it("promotes a draft and wires it in as a tool", () => {
    const ctx = booted();
    ctx.flows.saveDraft(draft("fetch-thing"));
    const out = handleCommand("/promote fetch-thing", ctx, "c1")!;
    expect(out).toContain("Promoted");
    expect(out).toContain("flow.fetch-thing");
    expect(ctx.flows.promoted().map((f) => f.name)).toEqual(["fetch-thing"]);
    expect(handleCommand("/habits", ctx, "c1")).toContain("run without thinking");
  });

  it("refuses to promote something that doesn't exist", () => {
    expect(handleCommand("/promote nope", booted(), "c1")).toContain('No draft habit called "nope"');
  });

  it("changes vibe per chat", () => {
    const ctx = booted();
    expect(handleCommand("/vibe funny", ctx, "c1")).toContain("funny");
    expect(ctx.vibes.current("c1")).toBe("funny");
    expect(ctx.vibes.current("c2")).toBe("warm");
    expect(handleCommand("/vibe nonsense", ctx, "c1")).toContain("No such vibe");
  });
});

describe("arming reflexes from chat", () => {
  beforeEach(clearNodes);

  const withHabit = () => {
    const ctx = booted();
    ctx.flows.saveDraft(draft("daily-report"));
    ctx.flows.promote("daily-report");
    return ctx;
  };

  it("refuses to arm a reflex for a habit that isn't promoted", () => {
    expect(handleCommand("/reflex morning daily-report 0 9 * * *", booted(), "c1")).toContain("isn't a promoted habit");
  });

  it("arms a cron reflex", () => {
    const ctx = withHabit();
    expect(handleCommand("/reflex morning daily-report 0 9 * * *", ctx, "c1")).toContain("without being asked");
    const [r] = ctx.reflexes.all();
    expect(r).toMatchObject({ name: "morning", flow: "daily-report", cron: "0 9 * * *", enabled: true });
  });

  it("arms a webhook reflex", () => {
    const ctx = withHabit();
    expect(handleCommand("/reflex on-order daily-report hook:order", ctx, "c1")).toContain("/hooks/order");
    const [r] = ctx.reflexes.all();
    expect(r.webhook).toBe("order");
    expect(r.cron).toBeUndefined();
  });

  it("rejects a broken schedule with a readable message, not a stack trace", () => {
    const out = handleCommand("/reflex morning daily-report not a cron at all", withHabit(), "c1")!;
    expect(out).toContain("Couldn't arm that");
    expect(out).not.toMatch(/at Object|node_modules/);
  });

  it("shows usage when told half a command", () => {
    expect(handleCommand("/reflex morning", withHabit(), "c1")).toContain("Usage:");
  });

  it("lists and removes reflexes", () => {
    const ctx = withHabit();
    expect(handleCommand("/reflexes", ctx, "c1")).toContain("No reflexes yet");
    handleCommand("/reflex morning daily-report 0 9 * * *", ctx, "c1");
    expect(handleCommand("/reflexes", ctx, "c1")).toContain("morning → daily-report");
    expect(handleCommand("/unreflex morning", ctx, "c1")).toContain("removed");
    expect(handleCommand("/unreflex morning", ctx, "c1")).toContain("No reflex");
  });

  it("documents everything in /help", () => {
    const help = handleCommand("/help", booted(), "c1")!;
    for (const cmd of ["/habits", "/promote", "/reflexes", "/reflex", "/unreflex", "/vibe"]) {
      expect(help).toContain(cmd);
    }
  });
});
