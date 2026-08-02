import { describe, it, expect } from "vitest";
import { Brains, loadBrainsConfig, type BrainsConfig } from "@squidclaw/brains";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const cfg: BrainsConfig = { tiers: { cheap: ["model-a"], strong: ["model-b", "model-c"] } };
const textResponse = { content: [{ type: "text", text: "hello" }] };

describe("brains router", () => {
  it("loads BRAINS.yaml", () => {
    const dir = mkdtempSync(join(tmpdir(), "brains-"));
    writeFileSync(join(dir, "BRAINS.yaml"), "tiers:\n  cheap: [m1]\n  strong: [m2, m3]\n");
    expect(loadBrainsConfig(join(dir, "BRAINS.yaml")).tiers.strong).toEqual(["m2", "m3"]);
  });

  it("routes tier to first model", async () => {
    const seen: string[] = [];
    const b = new Brains(cfg, async (req) => {
      seen.push(req.model as string);
      return textResponse;
    });
    const res = await b.complete({ tier: "cheap", messages: [{ role: "user", content: "hi" }] });
    expect(seen).toEqual(["model-a"]);
    expect(res.text).toBe("hello");
  });

  it("falls back to next model on failure", async () => {
    const seen: string[] = [];
    const b = new Brains(cfg, async (req) => {
      seen.push(req.model as string);
      if (req.model === "model-b") throw new Error("overloaded");
      return textResponse;
    });
    await b.complete({ tier: "strong", messages: [] });
    expect(seen).toEqual(["model-b", "model-c"]);
  });

  it("extracts tool calls", async () => {
    const b = new Brains(cfg, async () => ({
      content: [
        { type: "text", text: "calling" },
        { type: "tool_use", id: "tu_1", name: "echo", input: { value: 1 } },
      ],
    }));
    const res = await b.complete({ tier: "cheap", messages: [] });
    expect(res.toolCalls).toEqual([{ id: "tu_1", name: "echo", input: { value: 1 } }]);
  });
});
