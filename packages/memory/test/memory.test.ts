import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, getNode } from "@squidclaw/kernel";
import { ConversationStore, SemanticMemory, registerMemoryNodes, type Embedder } from "@squidclaw/memory";

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

  it("writes human-readable markdown files and recalls by substring", async () => {
    const m = new SemanticMemory(dir);
    m.remember("Tamer's coffee", "Tamer takes his coffee black, no sugar.");
    m.remember("Deploy rule", "Never deploy to production without explicit approval.");
    expect(m.all().map((x) => x.name).sort()).toEqual(["deploy-rule", "tamers-coffee"]);
    expect((await m.recall("coffee"))[0].content).toContain("black");
    expect((await m.recall("production"))[0].name).toBe("deploy-rule");
    expect(await m.recall("nothing here")).toEqual([]);
  });

  it("finds a fuzzy query no substring match would — 'ssh again' against a note that never says 'again'", async () => {
    const m = new SemanticMemory(dir);
    m.remember("preplix-ssh", "SSH access to 76.13.49.186 works: root, key-based auth.");
    m.remember("unrelated", "Tamer likes his tea with mint.");
    const hits = await m.recall("ssh again");
    expect(hits.map((h) => h.name)).toEqual(["preplix-ssh"]);
  });

  it("ranks the message-relevant memory above unrelated ones stored earlier", async () => {
    const m = new SemanticMemory(dir);
    m.remember("aa-first-alphabetically", "The weather was nice on Tuesday.");
    m.remember("zz-server-note", "The ash server at 76.13.49.186 runs n8n and needs sudo for the export.");
    const hits = await m.recall("how do I reach the ash server");
    expect(hits[0].name).toBe("zz-server-note"); // relevance wins, not alphabetical order
  });

  it("gives partial credit for near-matches (ssh vs sshd) without exploding on short tokens", async () => {
    const m = new SemanticMemory(dir);
    m.remember("sshd-note", "The sshd config on the box allows key auth only.");
    expect((await m.recall("ssh"))[0].name).toBe("sshd-note");
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

describe("true vector memory (semantic recall — no API, no shared words needed)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "sem-vec-"));
  });

  // A deterministic stand-in for a real embedding model: texts about the
  // same THEME land on the same point, regardless of exact wording.
  const themeEmbed: Embedder = async (text) => {
    const t = text.toLowerCase();
    if (/ssh|reach|box|server/.test(t)) return [1, 0];
    if (/tea|mint/.test(t)) return [0, 1];
    return [0.4, 0.4];
  };

  it("finds a paraphrase with ZERO shared words — the exact 'ssh again' bug, solved by meaning", async () => {
    const m = new SemanticMemory(dir, { embed: themeEmbed });
    m.remember("preplix-ssh", "SSH access to the server works.");
    m.remember("tea-note", "Tamer likes his tea with mint.");

    // Not one word here appears in the memory it should find.
    const hits = await m.recall("how do I reach my box");
    expect(hits.map((h) => h.name)).toEqual(["preplix-ssh"]);
  });

  it("blends word-overlap and meaning — strong in both outranks strong in only one", async () => {
    const m = new SemanticMemory(dir, { embed: themeEmbed });
    m.remember("both", "ssh server access — the box you reach it from matters.");
    m.remember("semantic-only", "You can reach that box remotely.");
    const hits = await m.recall("ssh into the server box");
    expect(hits[0].name).toBe("both");
  });

  it("a semantic-only match must clear a real similarity bar — embedding noise is not a hit", async () => {
    const m = new SemanticMemory(dir, { embed: themeEmbed, semanticFloor: 0.9 });
    m.remember("tea-note", "Tamer likes his tea with mint.");
    // cosine([1,0], [0.4,0.4]) ≈ 0.71 — real, but below a floor of 0.9.
    const hits = await m.recall("reach the box");
    expect(hits).toEqual([]);
  });

  it("degrades to lexical-only when the embedder stumbles — recall must never go silent", async () => {
    const broken: Embedder = async () => { throw new Error("embedding server down"); };
    const m = new SemanticMemory(dir, { embed: broken });
    m.remember("preplix-ssh", "SSH access to the server works.");
    const hits = await m.recall("ssh");
    expect(hits[0].name).toBe("preplix-ssh"); // word overlap still finds it
  });

  it("caches a memory's embedding and only recomputes when its content actually changes", async () => {
    let calls = 0;
    const counting: Embedder = async (text) => { calls++; return themeEmbed(text); };
    const m = new SemanticMemory(dir, { embed: counting });
    m.remember("preplix-ssh", "SSH access to the server works.");

    await m.recall("ssh"); // embeds the memory once, plus the query
    const afterFirst = calls;
    await m.recall("ssh"); // the memory's vector is cached now
    expect(calls).toBe(afterFirst + 1); // only the new query got embedded

    m.remember("preplix-ssh", "SSH access to the server works, now via a jump host.");
    await m.recall("ssh");
    expect(calls).toBeGreaterThan(afterFirst + 1); // stale cache invalidated, recomputed
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
