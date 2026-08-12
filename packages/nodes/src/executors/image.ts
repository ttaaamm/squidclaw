import type { Item, NodeContext } from "@squidclaw/kernel";
import { registerExecutor } from "./registry.js";
import { credentialStore } from "./credentials.js";

/**
 * OpenAI node — image generation (and inline chat).
 *
 * n8n's `@n8n/n8n-nodes-langchain.openAi` is multi-resource: `image` generates
 * a picture, `text`/`assistant` chats. We dispatch on the node's own `resource`
 * so an imported workflow's OpenAI step just works, whichever mode it's in.
 * Image comes back as a binary item (so downstream render/WordPress/Telegram
 * steps can use it) plus its url.
 */

const TIMEOUT_MS = 90_000;

function key(tenantId: string): string {
  const cred = credentialStore.resolve(tenantId, "openAiApi");
  const k = cred?.values.apiKey ?? cred?.values.key;
  if (!k) throw new Error(`This step needs an "openAiApi" credential — add your OpenAI API key to run it.`);
  return k;
}

function promptFrom(parameters: Record<string, unknown>, item: Item): string {
  const p = parameters as { prompt?: unknown; text?: unknown };
  if (typeof p.prompt === "string" && p.prompt.trim()) return p.prompt;
  if (typeof p.text === "string" && p.text.trim()) return p.text;
  const j = (item.json ?? {}) as Record<string, unknown>;
  for (const f of ["prompt", "text", "topic", "input"]) {
    if (typeof j[f] === "string" && (j[f] as string).trim()) return j[f] as string;
  }
  return JSON.stringify(j);
}

async function generateImage(tenantId: string, prompt: string, opts: Record<string, unknown>): Promise<{ url?: string; b64?: string }> {
  const model = String(opts.model ?? "dall-e-3");
  const size = String(opts.size ?? "1024x1024");
  const wantB64 = opts.responseFormat === "b64_json" || opts.binary === true;
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { authorization: `Bearer ${key(tenantId)}`, "content-type": "application/json" },
    body: JSON.stringify({ model, prompt, n: 1, size, response_format: wantB64 ? "b64_json" : "url" }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI image ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { data?: Array<{ url?: string; b64_json?: string }> };
  const first = body.data?.[0] ?? {};
  return { url: first.url, b64: first.b64_json };
}

async function chat(tenantId: string, parameters: Record<string, unknown>, prompt: string): Promise<string> {
  const opts = (parameters.options ?? {}) as Record<string, unknown>;
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key(tenantId)}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: String(parameters.model ?? opts.model ?? "gpt-4o-mini"),
      messages: [
        ...(typeof opts.systemMessage === "string" ? [{ role: "system", content: opts.systemMessage }] : []),
        { role: "user", content: prompt },
      ],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const b = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return b.choices?.[0]?.message?.content ?? "";
}

async function openAiNode(parameters: Record<string, unknown>, items: Item[], ctx: NodeContext): Promise<Item[]> {
  const resource = String(parameters.resource ?? "text");
  const base = items.length ? items : [{ json: {} } as Item];
  const out: Item[] = [];
  for (const item of base) {
    const prompt = promptFrom(parameters, item);
    if (resource === "image") {
      const img = await generateImage(ctx.tenantId, prompt, (parameters.options ?? {}) as Record<string, unknown>);
      if (img.b64) {
        out.push({
          json: { ...item.json, imageGenerated: true },
          binary: { data: { data: Buffer.from(img.b64, "base64"), fileName: "image.png", fileSize: 0 } },
        });
      } else {
        out.push({ json: { ...item.json, imageUrl: img.url, url: img.url } });
      }
    } else {
      const text = await chat(ctx.tenantId, parameters, prompt);
      out.push({ ...item, json: { ...item.json, text, response: text } });
    }
  }
  return out;
}

registerExecutor("@n8n/n8n-nodes-langchain.openAi", openAiNode);
