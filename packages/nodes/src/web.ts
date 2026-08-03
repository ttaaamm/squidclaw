import type { NodeDef } from "@squidclaw/kernel";

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

export const webSearchNode: NodeDef = {
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
    const res = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": "Mozilla/5.0 (compatible; SquidClaw/0.1)",
      },
      body: new URLSearchParams({ q: String(params.query) }).toString(),
    });
    if (!res.ok) return [{ json: { error: `search failed: HTTP ${res.status}` } }];
    const hits = parseDuckDuckGo(await res.text()).slice(0, limit);
    return hits.length ? hits.map((h) => ({ json: { ...h } })) : [{ json: { found: false } }];
  },
};

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
