import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, getNode } from "@squidclaw/kernel";
import { ConversationStore, SemanticMemory, registerMemoryNodes } from "@squidclaw/memory";

describe("conversation store (episodic memory)", () => {
  it("remembers turns in order, oldest first", () => {
    const c = new ConversationStore(":memory:");
    c.append("t1", "chat1", "user", "my name is Tamer");
    c.append("t1", "chat1", "assistant", "noted");
    c.append("t1", "chat1", "user", "what is my name?");
    expect(c.recent("t1", "chat1").map((t) => t.content)).toEqual([
      "my name is Tamer", "noted", "what is my name?",
    ]);
  });

  it("keeps chats and tenants apart", () => {
    const c = new ConversationStore(":memory:");
    c.append("t1", "chat1", "user", "secret one");
    c.append("t1", "chat2", "user", "secret two");
    c.append("t2", "chat1", "user", "other tenant");
    expect(c.recent("t1", "chat1").map((t) => t.content)).toEqual(["secret one"]);
    expect(c.recent("t2", "chat1").map((t) => t.content)).toEqual(["other tenant"]);
  });

  it("caps history at the configured depth", () => {
    const c = new ConversationStore(":memory:", 3);
    for (let i = 1; i <= 5; i++) c.append("t", "c", "user", `m${i}`);
    expect(c.recent("t", "c").map((t) => t.content)).toEqual(["m3", "m4", "m5"]);
  });
});

describe("semantic memory (what it knows)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sem-"));
  });

  it("writes human-readable markdown files and recalls by substring", () => {
    const m = new SemanticMemory(dir);
    m.remember("Tamer's coffee", "Tamer takes his coffee black, no sugar.");
    m.remember("Deploy rule", "Never deploy to production without explicit approval.");
    expect(m.all().map((x) => x.name).sort()).toEqual(["deploy-rule", "tamers-coffee"]);
    expect(m.recall("coffee")[0].content).toContain("black");
    expect(m.recall("production")[0].name).toBe("deploy-rule");
    expect(m.recall("nothing here")).toEqual([]);
  });

  it("overwrites a memory with the same name rather than duplicating", () => {
    const m = new SemanticMemory(dir);
    m.remember("fact", "old");
    m.remember("fact", "new");
    expect(m.all()).toHaveLength(1);
    expect(m.all()[0].content).toBe("new");
  });

  it("forgets", () => {
    const m = new SemanticMemory(dir);
    m.remember("temp", "throwaway");
    expect(m.forget("temp")).toBe(true);
    expect(m.all()).toHaveLength(0);
  });
});

describe("memory tools", () => {
  it("lets the agent remember and recall through nodes", async () => {
    clearNodes();
    const m = new SemanticMemory(mkdtempSync(join(tmpdir(), "sem-")));
    registerMemoryNodes(m);

    await getNode("memory.remember")!.run(
      { name: "favourite server", content: "Tamer prefers the Preplix VPS." }, [], { tenantId: "t" },
    );
    const out = await getNode("memory.recall")!.run({ query: "preplix" }, [], { tenantId: "t" });

    expect(out[0].json.content).toContain("Preplix VPS");
  });
});
