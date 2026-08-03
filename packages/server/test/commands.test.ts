import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, Journal } from "@squidclaw/kernel";
import { Agent, FlowStore, VibeState, DEFAULT_VIBES, type Flow } from "@squidclaw/agent";
import { handleCommand, type Booted } from "./../src/boot.js";

const draft = (name: string): Flow => ({
  name, description: "does a thing", signature: "http.request", triggers: ["do it"],
  params: ["url"], runs: 2, createdAt: "now", status: "draft",
  graph: { nodes: [{ id: "n1", node: "http.request", params: { url: "{{url}}" } }], edges: [] },
});

function booted(): Booted {
  const flows = new FlowStore(mkdtempSync(join(tmpdir(), "cmd-")));
  const journal = new Journal(":memory:");
  return {
    flows,
    journal,
    vibes: new VibeState(DEFAULT_VIBES),
    agent: new Agent({ brains: null as never, journal, tenantId: "dev", innerMe: "", flows }),
    workspace: "/tmp",
    via: "cli",
    mcp: { registered: [], failed: {} },
  } as unknown as Booted;
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
