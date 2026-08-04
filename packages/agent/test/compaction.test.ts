import { describe, it, expect, beforeEach } from "vitest";
import { clearNodes, registerNode, Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains } from "@squidclaw/brains";
import { Agent, compactRun, runSize } from "@squidclaw/agent";

/**
 * In-run compaction: long tasks fold their oldest tool rounds instead of
 * drowning in them — and a tool_use is NEVER separated from its result.
 */

const use = (id: string, name: string, input: Record<string, unknown>) => ({
  role: "assistant",
  content: [{ type: "tool_use", id, name, input }],
});
const result = (id: string, content: string) => ({
  role: "user",
  content: [{ type: "tool_result", tool_use_id: id, content }],
});

describe("compactRun", () => {
  it("leaves a small transcript completely untouched", () => {
    const messages = [{ role: "user", content: "hi" }, use("t1", "web.search", { q: "x" }), result("t1", "found")];
    expect(compactRun(messages, 60_000)).toBe(messages);
  });

  it("folds oldest pairs whole, keeps the newest pair intact", () => {
    const big = "x".repeat(3_000);
    const messages = [
      { role: "user", content: "do the big thing" },
      use("t1", "web.search", { q: "one" }), result("t1", big),
      use("t2", "web.read", { url: "two" }), result("t2", big),
      use("t3", "pdf.create", { title: "three" }), result("t3", big),
    ];
    const out = compactRun(messages, 5_000) as Array<{ role: string; content: unknown }>;

    expect(runSize(out)).toBeLessThan(runSize(messages));
    const flat = JSON.stringify(out);
    // The newest pair survives whole…
    expect(flat).toContain('"t3"');
    expect(out.filter((m) => JSON.stringify(m.content).includes('"tool_use"'))).toHaveLength(1);
    // …older rounds became one compact note that still tells the story…
    expect(flat).toContain("compacted");
    expect(flat).toContain("web.search");
    expect(flat).toContain("web.read");
    // …and their bulk is gone.
    expect(flat.match(/x{3000}/g) ?? []).toHaveLength(1); // only t3's payload remains

    // The cardinal rule: every remaining tool_use has its result right after it.
    out.forEach((m, i) => {
      if (JSON.stringify(m.content).includes('"tool_use"')) {
        expect(JSON.stringify(out[i + 1]?.content)).toContain('"tool_result"');
      }
    });
  });

  it("keeps the human's original ask at the front", () => {
    const big = "y".repeat(4_000);
    const messages = [
      { role: "user", content: "the original mission" },
      use("a", "n1", {}), result("a", big),
      use("b", "n2", {}), result("b", big),
    ];
    const out = compactRun(messages, 3_000) as Array<{ role: string; content: unknown }>;
    expect(out[0].content).toBe("the original mission");
  });
});

describe("compaction inside the loop", () => {
  beforeEach(() => {
    clearNodes();
    registerBuiltinNodes();
  });

  it("a many-round run stays within budget for the model's final look", async () => {
    registerNode({
      name: "blob.make", description: "", inputSchema: {},
      run: async () => [{ json: { blob: "z".repeat(2_500) } }],
    });
    const sizesSeen: number[] = [];
    let round = 0;
    const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
      sizesSeen.push(JSON.stringify((req as { messages: unknown[] }).messages).length);
      round++;
      if (round <= 5) return { content: [{ type: "tool_use", id: `t${round}`, name: "blob__make", input: {} }] };
      return { content: [{ type: "text", text: "done after five rounds" }] };
    });
    const agent = new Agent({ brains, journal: new Journal(":memory:"), tenantId: "t", innerMe: "s", runBudgetChars: 6_000 });

    const reply = await agent.handleMessage("gather all the blobs");
    expect(reply).toBe("done after five rounds");
    // Without compaction the final call would carry ~5 × 2.5k of blob; with
    // it, the transcript the model sees stays near the budget.
    expect(sizesSeen.at(-1)!).toBeLessThan(9_000);
  });
});
