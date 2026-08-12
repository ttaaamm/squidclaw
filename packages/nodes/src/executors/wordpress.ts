import type { Item, NodeContext, BinaryValue } from "@squidclaw/kernel";
import { binaryBuffer } from "@squidclaw/kernel";
import { registerExecutor } from "./registry.js";
import { credentialStore } from "./credentials.js";

/**
 * WordPress — create a post (default: draft), with a chosen author, and if an
 * image rode in on the item's binary, upload it to the media library and set
 * it as the featured image. Auth is an Application Password (username + app
 * password), the standard headless-WordPress credential.
 *
 * Credential type `wordpressApi`: { url, username, password }.
 */

const TIMEOUT_MS = 60_000;

function creds(tenantId: string): { url: string; auth: string } {
  const c = credentialStore.resolve(tenantId, "wordpressApi");
  const url = c?.values.url;
  const username = c?.values.username;
  const password = c?.values.password ?? c?.values.appPassword;
  if (!url || !username || !password) {
    throw new Error(`This step needs a "wordpressApi" credential — add your WordPress URL, username and application password.`);
  }
  return {
    url: url.replace(/\/+$/, ""),
    auth: "Basic " + Buffer.from(`${username}:${password}`).toString("base64"),
  };
}

function field(parameters: Record<string, unknown>, item: Item, ...names: string[]): string | undefined {
  const extra = (parameters.additionalFields ?? {}) as Record<string, unknown>;
  const j = (item.json ?? {}) as Record<string, unknown>;
  for (const n of names) {
    if (typeof parameters[n] === "string" && (parameters[n] as string).trim()) return parameters[n] as string;
    if (typeof extra[n] === "string" && (extra[n] as string).trim()) return extra[n] as string;
    if (typeof j[n] === "string" && (j[n] as string).trim()) return j[n] as string;
  }
  return undefined;
}

async function uploadMedia(url: string, auth: string, bin: BinaryValue): Promise<number | undefined> {
  const buf = binaryBuffer(bin);
  const meta = bin as { fileName?: string; mimeType?: string };
  const res = await fetch(`${url}/wp-json/wp/v2/media`, {
    method: "POST",
    headers: {
      authorization: auth,
      "content-type": meta.mimeType ?? "image/png",
      "content-disposition": `attachment; filename="${meta.fileName ?? "image.png"}"`,
    },
    // Buffer is a valid fetch body at runtime. The cast is needed because TS
    // 5.7 made typed arrays generic over their backing buffer, so neither
    // Buffer nor Uint8Array structurally matches BufferSource any more.
    body: buf as unknown as BodyInit,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`WordPress media upload ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return ((await res.json()) as { id?: number }).id;
}

async function wordpressNode(parameters: Record<string, unknown>, items: Item[], ctx: NodeContext): Promise<Item[]> {
  const { url, auth } = creds(ctx.tenantId);
  const base = items.length ? items : [{ json: {} } as Item];
  const out: Item[] = [];

  for (const item of base) {
    const title = field(parameters, item, "title") ?? "Untitled";
    const content = field(parameters, item, "content", "body", "article", "text") ?? "";
    const status = field(parameters, item, "status") ?? "draft";
    const authorRaw = field(parameters, item, "authorId", "author");
    const author = authorRaw ? Number(authorRaw) : undefined;

    // If an image came down the flow, put it in the media library and feature it.
    let featured: number | undefined;
    const image = item.binary?.data;
    if (image) featured = await uploadMedia(url, auth, image);

    const res = await fetch(`${url}/wp-json/wp/v2/posts`, {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json" },
      body: JSON.stringify({
        title,
        content,
        status,
        ...(author != null && !Number.isNaN(author) ? { author } : {}),
        ...(featured ? { featured_media: featured } : {}),
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`WordPress post ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const post = (await res.json()) as { id?: number; link?: string; status?: string };
    out.push({ json: { ...item.json, wordpressId: post.id, link: post.link, status: post.status } });
  }
  return out;
}

registerExecutor("n8n-nodes-base.wordpress", wordpressNode);
