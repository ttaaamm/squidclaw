import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Journal } from "@squidclaw/kernel";
import { Brains } from "@squidclaw/brains";
import { Agent, VibeState, loadVibes, DEFAULT_VIBES } from "@squidclaw/agent";

describe("vibes (how it sounds)", () => {
  it("ships a default set and falls back when no file exists", () => {
    const cfg = loadVibes();
    expect(Object.keys(cfg.vibes)).toEqual(expect.arrayContaining(["warm", "formal", "funny", "brief", "teacher"]));
    expect(cfg.default).toBe("warm");
  });

  it("merges custom vibes from yaml over the defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibes-"));
    writeFileSync(join(dir, "VIBES.yaml"), 'default: pirate\nvibes:\n  pirate: "Speak like a pirate."\n');
    const cfg = loadVibes(join(dir, "VIBES.yaml"));
    expect(cfg.default).toBe("pirate");
    expect(cfg.vibes.pirate).toBe("Speak like a pirate.");
    expect(cfg.vibes.formal).toBe(DEFAULT_VIBES.vibes.formal); // defaults survive
  });

  it("ignores a default that names a vibe that doesn't exist", () => {
    const dir = mkdtempSync(join(tmpdir(), "vibes-"));
    writeFileSync(join(dir, "VIBES.yaml"), "default: nonexistent\n");
    expect(loadVibes(join(dir, "VIBES.yaml")).default).toBe("warm");
  });

  it("tracks tone per chat, not globally", () => {
    const state = new VibeState(DEFAULT_VIBES);
    expect(state.set("chat1", "funny")).toBe(true);
    expect(state.set("chat2", "nope")).toBe(false);
    expect(state.current("chat1")).toBe("funny");
    expect(state.current("chat2")).toBe("warm");
    expect(state.prompt("chat1")).toContain("mischievous");
  });
});

describe("the agent speaks in its vibe", () => {
  it("carries the chat's tone into the system prompt", async () => {
    let system = "";
    const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
      system = req.system as string;
      return { content: [{ type: "text", text: "ok" }] };
    });
    const vibes = new VibeState(DEFAULT_VIBES);
    vibes.set("chat1", "formal");

    const agent = new Agent({
      brains, journal: new Journal(":memory:"), tenantId: "dev", innerMe: "I am SquidClaw.", vibes,
    });
    await agent.handleMessage("hello", "chat1");

    expect(system).toContain("I am SquidClaw.");
    expect(system).toContain("How I speak (formal)");
    expect(system).toContain("no emoji");
  });
});
