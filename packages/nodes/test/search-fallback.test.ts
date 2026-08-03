import { describe, it, expect } from "vitest";
import { searchWeb, cliSearchEngine, webSearchNode, type SearchEngine, type SearchHit } from "@squidclaw/nodes";

const hit = (n: number): SearchHit => ({ title: `t${n}`, url: `https://x/${n}`, snippet: `s${n}` });

const failing = (name: string): SearchEngine => ({
  name,
  search: async () => {
    throw new Error(`${name} is blocked`);
  },
});

const working = (name: string): SearchEngine => ({
  name,
  search: async (_q, limit) => [hit(1), hit(2)].slice(0, limit),
});

describe("search survives a blocked engine", () => {
  it("falls through to the next engine when the first refuses", async () => {
    const { hits, engine } = await searchWeb("saudi news", 5, [failing("duckduckgo"), working("claude-cli")]);
    expect(engine).toBe("claude-cli");
    expect(hits).toHaveLength(2);
  });

  it("reports every engine's failure when all refuse — never a silent empty answer", async () => {
    await expect(searchWeb("q", 5, [failing("duckduckgo"), failing("firecrawl")])).rejects.toThrow(
      /duckduckgo is blocked.*firecrawl is blocked/,
    );
  });

  it("the node surfaces which engine actually answered", async () => {
    const node = webSearchNode([failing("duckduckgo"), working("backup")]);
    const out = await node.run({ query: "q", limit: 1 }, [], { tenantId: "t" });
    expect(out[0].json.engine).toBe("backup");
    expect(out[0].json.title).toBe("t1");
  });

  it("a failing search throws out of the node — the agent must see it, not guess", async () => {
    const node = webSearchNode([failing("only")]);
    await expect(node.run({ query: "q" }, [], { tenantId: "t" })).rejects.toThrow(/every search engine refused/);
  });
});

describe("the cli engine", () => {
  it("asks the CLI to search and digs results out of noisy output", async () => {
    let seenArgs: string[] = [];
    const engine = cliSearchEngine(async (args) => {
      seenArgs = args;
      return 'hook noise\n{"results":[{"title":"Arab News","url":"https://arabnews.com","snippet":"news"}]}\ntrailing noise';
    });
    const hits = await engine.search("saudi news", 3);
    expect(seenArgs).toContain("--allowedTools");
    expect(seenArgs).toContain("WebSearch");
    expect(seenArgs.join(" ")).toContain("saudi news");
    expect(hits[0].url).toBe("https://arabnews.com");
  });

  it("treats empty results as a refusal so the chain can report honestly", async () => {
    const engine = cliSearchEngine(async () => '{"results":[]}');
    await expect(engine.search("q", 3)).rejects.toThrow(/no results/);
  });
});
