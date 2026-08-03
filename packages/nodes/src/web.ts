import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { NodeDef } from "@squidclaw/kernel";

const run = promisify(execFile);
const MAX_TEXT = 100_000;

/** Strips a page down to what a reader would actually see. */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|br)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/**
 * One way of searching. Engines throw when they can't deliver — an empty
 * answer from a blocked engine must fall through, not masquerade as "no news".
 */
export interface SearchEngine {
  name: string;
  search(query: string, limit: number): Promise<SearchHit[]>;
}

/** DuckDuckGo's no-JS endpoint: no key, no quota, good enough to start. */
export function parseDuckDuckGo(html: string): SearchHit[] {
  const hits: SearchHit[] = [];
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const block of blocks) {
    const linkMatch = block.match(/<a[^>]+class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    const snippetMatch = block.match(/<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    let url = linkMatch[1];
    const uddg = url.match(/[?&]uddg=([^&]+)/);
    if (uddg) url = decodeURIComponent(uddg[1]);
    if (url.startsWith("//")) url = `https:${url}`;
    hits.push({
      title: htmlToText(linkMatch[2]),
      url,
      snippet: snippetMatch ? htmlToText(snippetMatch[1]) : "",
    });
    if (hits.length >= 10) break;
  }
  return hits;
}

export const duckDuckGoEngine: SearchEngine = {
  name: "duckduckgo",
  async search(query, limit) {
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Mozilla/5.0 (compatible; SquidClaw/0.1)",
      },
      body: new URLSearchParams({ q: query }).toString(),
    });
    const hits = parseDuckDuckGo(await res.text()).slice(0, limit);
    // DDG answers bot-challenges with HTTP 202 and a resultless page —
    // that's a refusal, not an empty world.
    if (!hits.length) throw new Error(`duckduckgo returned no results (HTTP ${res.status} — likely bot-blocked)`);
    return hits;
  },
};

/** Firecrawl, when a key is around — a proper search API. */
export function firecrawlEngine(apiKey: string): SearchEngine {
  return {
    name: "firecrawl",
    async search(query, limit) {
      const res = await fetch("https://api.firecrawl.dev/v1/search", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ query, limit }),
      });
      if (!res.ok) throw new Error(`firecrawl: HTTP ${res.status}`);
      const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
      const hits = (body.data ?? [])
        .map((d) => ({
          title: String(d.title ?? d.url ?? ""),
          url: String(d.url ?? ""),
          snippet: String(d.description ?? d.snippet ?? ""),
        }))
        .filter((h) => h.url);
      if (!hits.length) throw new Error("firecrawl returned no results");
      return hits.slice(0, limit);
    },
  };
}

const CLI_SEARCH_SCHEMA = JSON.stringify({
  type: "object",
  required: ["results"],
  properties: {
    results: {
      type: "array",
      items: {
        type: "object",
        required: ["title", "url", "snippet"],
        properties: { title: { type: "string" }, url: { type: "string" }, snippet: { type: "string" } },
      },
    },
  },
});

/**
 * The Claude CLI's own WebSearch — searches through the subscription, from
 * any IP. Slower than a search API, but it works where scrapers get blocked,
 * which is exactly what happened on the first production server.
 */
export function cliSearchEngine(
  exec: (args: string[]) => Promise<string> = async (args) =>
    (await run("claude", args, { timeout: 120_000, maxBuffer: 8 * 1024 * 1024 })).stdout,
): SearchEngine {
  return {
    name: "claude-cli",
    async search(query, limit) {
      const raw = await exec([
        "-p", `Search the web for: ${query}\nReturn the top ${limit} results.`,
        "--allowedTools", "WebSearch",
        "--model", "haiku",
        "--json-schema", CLI_SEARCH_SCHEMA,
      ]);
      const start = raw.indexOf("{");
      const end = raw.lastIndexOf("}");
      if (start === -1 || end <= start) throw new Error("claude-cli: no JSON in output");
      const parsed = JSON.parse(raw.slice(start, end + 1)) as { results?: SearchHit[] };
      if (!parsed.results?.length) throw new Error("claude-cli returned no results");
      return parsed.results.slice(0, limit);
    },
  };
}

/** Tries each engine in order; reports every failure if all refuse. */
export async function searchWeb(
  query: string,
  limit: number,
  engines: SearchEngine[],
): Promise<{ hits: SearchHit[]; engine: string }> {
  const failures: string[] = [];
  for (const engine of engines) {
    try {
      return { hits: await engine.search(query, limit), engine: engine.name };
    } catch (err) {
      failures.push(`${engine.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(`every search engine refused — ${failures.join(" · ")}`);
}

export function defaultEngines(): SearchEngine[] {
  const engines: SearchEngine[] = [duckDuckGoEngine];
  if (process.env.FIRECRAWL_API_KEY) engines.push(firecrawlEngine(process.env.FIRECRAWL_API_KEY));
  engines.push(cliSearchEngine());
  return engines;
}

export function webSearchNode(engines?: SearchEngine[]): NodeDef {
  return {
    name: "web.search",
    description:
      "Search the web. Params: query (required), limit (optional, default 5). Returns one item per result with {title, url, snippet}. Follow up with web.read to get a page's full text.",
    inputSchema: {
      type: "object",
      required: ["query"],
      properties: { query: { type: "string" }, limit: { type: "number" } },
    },
    run: async (params) => {
      const limit = (params.limit as number) ?? 5;
      const { hits, engine } = await searchWeb(String(params.query), limit, engines ?? defaultEngines());
      return hits.map((h) => ({ json: { ...h, engine } }));
    },
  };
}

export const webReadNode: NodeDef = {
  name: "web.read",
  description:
    "Fetch a web page and return its readable text (scripts, styles and markup stripped). Params: url (required), maxChars (optional). Use after web.search, or on any URL a human gives you.",
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: { url: { type: "string" }, maxChars: { type: "number" } },
  },
  run: async (params) => {
    const res = await fetch(String(params.url), {
      headers: { "user-agent": "Mozilla/5.0 (compatible; SquidClaw/0.1)" },
      redirect: "follow",
    });
    const body = await res.text();
    const contentType = res.headers.get("content-type") ?? "";
    const text = contentType.includes("html") ? htmlToText(body) : body;
    const max = (params.maxChars as number) ?? MAX_TEXT;
    return [
      {
        json: {
          url: String(params.url),
          status: res.status,
          text: text.slice(0, max),
          truncated: text.length > max,
        },
      },
    ];
  },
};
