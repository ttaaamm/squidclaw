import { existsSync, readFileSync } from "node:fs";
import type { NodeDef } from "@squidclaw/kernel";
import { fetchWithRetry } from "./retry.js";

/**
 * Sight, in the other direction: the agent can now make images, not just
 * read them. The key comes from the environment, or from the same keys.json
 * the formal-post pipeline keeps (set via its /setkey wizard) — one key
 * store, every organ drinks from it.
 */
function openaiKey(): string | undefined {
  if (process.env.OPENAI_API_KEY) return process.env.OPENAI_API_KEY;
  const path = process.env.SQUIDCLAW_SOCIAL_KEYS ?? "/opt/social/keys.json";
  try {
    if (existsSync(path)) {
      const keys = JSON.parse(readFileSync(path, "utf8")) as { openai?: string };
      return keys.openai || undefined;
    }
  } catch { /* no key store is fine — the error below says what to do */ }
  return undefined;
}

export function imageGenerateNode(): NodeDef {
  return {
    name: "image.generate",
    description:
      "Generate an image from a text prompt. Params: prompt (required — describe the image), " +
      "size ('1024x1024' default, '1536x1024' landscape, '1024x1536' portrait). " +
      "The image flows onward as binary — chain telegram.send with a filename to deliver it.",
    inputSchema: {
      type: "object",
      required: ["prompt"],
      properties: { prompt: { type: "string" }, size: { type: "string" } },
    },
    run: async (params) => {
      const key = openaiKey();
      if (!key) {
        throw new Error("image.generate: no OpenAI key — set OPENAI_API_KEY, or store one with the formal-post wizard's /setkey openai");
      }
      const base = process.env.SQUIDCLAW_OPENAI_API ?? "https://api.openai.com";
      const res = await fetchWithRetry(`${base}/v1/images/generations`, {
        method: "POST",
        headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
        body: JSON.stringify({
          model: "gpt-image-2",
          prompt: String(params.prompt),
          size: String(params.size ?? "1024x1024"),
          n: 1,
        }),
      });
      const body = (await res.json()) as { data?: Array<{ b64_json?: string }>; error?: { message?: string } };
      if (body.error) throw new Error(`image.generate: ${body.error.message ?? "the image API refused"}`);
      const b64 = body.data?.[0]?.b64_json;
      if (!b64) throw new Error("image.generate: the API returned no image");
      const buf = Buffer.from(b64, "base64");
      return [{
        json: { generated: true, prompt: String(params.prompt), bytes: buf.length },
        binary: { data: { data: buf, fileName: "generated.png", mimeType: "image/png", fileSize: buf.length } },
      }];
    },
  };
}
