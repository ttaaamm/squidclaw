import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ConversationStore, KnowledgeBase, Profiles, SemanticMemory,
  chunkText, knowledgeNodes, profileNodes,
} from "@squidclaw/memory";

const dir = () => mkdtempSync(join(tmpdir(), "deep-"));

describe("the knowledge base", () => {
  it("chunks long text on natural edges with overlap", () => {
    const text = Array.from({ length: 30 }, (_, i) => `Paragraph ${i} about topic ${i}.`).join("\n\n");
    const chunks = chunkText(text, 300, 50);
    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((c) => c.length <= 320)).toBe(true);
  });

  it("finds the relevant passage, not just any passage", () => {
    const kb = new KnowledgeBase(dir());
    kb.add("invoices.md", "Invoices for Al Jood are due on the 5th of each month. Payment goes to Riyad Bank.");
    kb.add("social.md", "The Saudi Times posts twice daily. Brand color is monochrome black.");
    kb.add("servers.md", "The VPS is at Hostinger. SSH uses key auth only, no passwords.");

    const hits = kb.search("when are Al Jood invoices due?");
    expect(hits[0].source).toBe("invoices.md");

    const social = kb.search("what is the posting schedule?");
    expect(social[0].source).toBe("social.md");
  });

  it("re-ingesting a source replaces it instead of duplicating", () => {
    const kb = new KnowledgeBase(dir());
    kb.add("policy.md", "The old policy says X.");
    kb.add("policy.md", "The new policy says Y.");
    expect(kb.docs()).toHaveLength(1);
    expect(kb.search("policy")[0].text).toContain("new policy");
  });

  it("works as agent tools, reading files through the injected extractor", async () => {
    const d = dir();
    const filePath = join(d, "notes.txt");
    writeFileSync(filePath, "The wifi password at the office is squid2026.");
    const kb = new KnowledgeBase(join(d, "kb"));
    const [ingest, search] = knowledgeNodes(kb, async (p) => readFileSync(p, "utf8"));

    await ingest.run({ path: filePath }, [], { tenantId: "t" });
    const out = await search.run({ query: "wifi password" }, [], { tenantId: "t" });
    expect(out[0].json.passage).toContain("squid2026");
  });
});

describe("contact profiles", () => {
  it("builds a structured picture of a person across calls", () => {
    const profiles = new Profiles(dir());
    profiles.set("Khalid", "role", "accountant at Al Jood");
    profiles.set("Khalid", "phone", "+966-5x-xxx");
    profiles.note("Khalid", "prefers WhatsApp over email");

    const khalid = profiles.get("khalid")!; // case-insensitive lookup
    expect(khalid.fields.role).toContain("accountant");
    expect(khalid.notes).toHaveLength(1);
    expect(profiles.all()).toHaveLength(1);
  });

  it("serves the agent as tools", async () => {
    const [set, , get, list] = profileNodes(new Profiles(dir()));
    await set.run({ person: "Sara", field: "birthday", value: "March 3" }, [], { tenantId: "t" });
    const out = await get.run({ person: "Sara" }, [], { tenantId: "t" });
    expect((out[0].json.fields as Record<string, string>).birthday).toBe("March 3");
    expect((await list.run({}, [], { tenantId: "t" }))[0].json.person).toBe("Sara");
  });
});

describe("memory decay", () => {
  it("retires stale memories to the archive but never the protected ones", () => {
    const d = dir();
    const memory = new SemanticMemory(d);
    memory.remember("my-human", "Tamer");
    memory.remember("old-fact", "something from long ago");

    // Backdate both by editing the metadata the store keeps.
    const metaPath = join(d, ".meta.json");
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    writeFileSync(metaPath, JSON.stringify({ "my-human": { createdAt: old }, "old-fact": { createdAt: old } }));

    const retired = memory.decay({ maxAgeDays: 45, protect: ["my-human"] });
    expect(retired).toEqual(["old-fact"]);
    expect(memory.all().map((m) => m.name)).toEqual(["my-human"]);
    expect(existsSync(join(d, "_archive", "old-fact.md"))).toBe(true); // recoverable, not deleted
  });

  it("being recalled keeps a memory alive", () => {
    const d = dir();
    const memory = new SemanticMemory(d);
    memory.remember("used-fact", "recalled often");
    const old = new Date(Date.now() - 90 * 86_400_000).toISOString();
    writeFileSync(join(d, ".meta.json"), JSON.stringify({ "used-fact": { createdAt: old } }));

    memory.recall("recalled"); // touch it
    expect(memory.decay({ maxAgeDays: 45 })).toEqual([]);
  });
});

describe("conversation summaries", () => {
  it("stores and updates the rolling summary per chat", () => {
    const c = new ConversationStore(":memory:");
    c.setSummary("t", "chat1", "They discussed invoices.", 20);
    c.setSummary("t", "chat1", "They discussed invoices, then servers.", 40);
    expect(c.summary("t", "chat1")).toEqual({ summary: "They discussed invoices, then servers.", turnsCovered: 40 });
    expect(c.summary("t", "chat2")).toBeUndefined();
  });

  it("hands back the exact slice of turns to fold in", () => {
    const c = new ConversationStore(":memory:");
    for (let i = 1; i <= 10; i++) c.append("t", "chat1", "user", `m${i}`);
    expect(c.count("t", "chat1")).toBe(10);
    expect(c.turnsBetween("t", "chat1", 2, 5).map((t) => t.content)).toEqual(["m3", "m4", "m5"]);
  });
});
