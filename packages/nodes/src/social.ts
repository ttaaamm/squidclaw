import type { NodeDef } from "@squidclaw/kernel";
import { fetchWithRetry } from "./retry.js";

/**
 * Publishing, not just drafting: the last meter of the Saudi Times loop.
 *
 * Instagram's Graph API takes a PUBLIC image URL (not bytes), creates a
 * media container, then publishes it — two calls, both here. Needs a
 * Business/Creator account wired to a Facebook app: set
 * INSTAGRAM_ACCESS_TOKEN (long-lived) and INSTAGRAM_ACCOUNT_ID (the IG
 * user id). Until those exist the node fails with instructions, honestly.
 */
export function instagramPublishNode(): NodeDef {
  return {
    name: "instagram.publish",
    description:
      "Publish an image post to the connected Instagram account. Params: imageUrl (required — a PUBLIC https URL " +
      "of the image), caption (the post caption, hashtags included). Returns the published media id. " +
      "Ask the human before publishing anything — a post is public and hard to retract.",
    inputSchema: {
      type: "object",
      required: ["imageUrl"],
      properties: { imageUrl: { type: "string" }, caption: { type: "string" } },
    },
    run: async (params) => {
      const token = process.env.INSTAGRAM_ACCESS_TOKEN;
      const account = process.env.INSTAGRAM_ACCOUNT_ID;
      if (!token || !account) {
        throw new Error(
          "instagram.publish: not connected — set INSTAGRAM_ACCESS_TOKEN and INSTAGRAM_ACCOUNT_ID " +
          "(an Instagram Business account linked to a Facebook app; long-lived token).",
        );
      }
      const base = process.env.SQUIDCLAW_GRAPH_API ?? "https://graph.facebook.com/v23.0";

      const create = await fetchWithRetry(`${base}/${account}/media`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          image_url: String(params.imageUrl),
          ...(params.caption ? { caption: String(params.caption) } : {}),
          access_token: token,
        }),
      });
      const container = (await create.json()) as { id?: string; error?: { message?: string } };
      if (!container.id) throw new Error(`instagram.publish: container failed — ${container.error?.message ?? create.status}`);

      const publish = await fetchWithRetry(`${base}/${account}/media_publish`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ creation_id: container.id, access_token: token }),
      });
      const posted = (await publish.json()) as { id?: string; error?: { message?: string } };
      if (!posted.id) throw new Error(`instagram.publish: publish failed — ${posted.error?.message ?? publish.status}`);

      return [{ json: { published: true, mediaId: posted.id, imageUrl: params.imageUrl } }];
    },
  };
}
