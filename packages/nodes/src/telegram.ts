import type { Item, NodeDef } from "@squidclaw/kernel";

export interface TelegramSendOptions {
  /** Overridable for tests; defaults to the real Bot API. */
  apiRoot?: string;
  token?: string;
}

/**
 * Telegram as a hand, not just a face.
 *
 * The surface listens; this node speaks — from inside a flow. Give it text and
 * it sends a message; give it items carrying binary data and a filename and it
 * sends the file. That pair is most of what the Saudi Times bots do all day.
 */
export function telegramSendNode(opts: TelegramSendOptions = {}): NodeDef {
  return {
    name: "telegram.send",
    description:
      "Send a Telegram message or file as this bot. Params: chatId (required), text (message to send), filename (when sending the binary data flowing in from the previous node, e.g. a rendered PDF). Returns {sent, kind}.",
    inputSchema: {
      type: "object",
      required: ["chatId"],
      properties: {
        chatId: { type: "string" },
        text: { type: "string" },
        filename: { type: "string" },
      },
    },
    run: async (params, items: Item[]) => {
      const token = opts.token ?? process.env.TELEGRAM_BOT_TOKEN;
      if (!token) throw new Error("telegram.send: TELEGRAM_BOT_TOKEN missing");
      const api = `${opts.apiRoot ?? "https://api.telegram.org"}/bot${token}`;

      const binary = items.find((i) => i.binary?.data)?.binary?.data;

      if (params.filename && binary) {
        const form = new FormData();
        form.append("chat_id", String(params.chatId));
        if (params.text) form.append("caption", String(params.text));
        form.append("document", new Blob([new Uint8Array(binary)]), String(params.filename));
        const res = await fetch(`${api}/sendDocument`, { method: "POST", body: form });
        const body = (await res.json()) as { ok: boolean; description?: string };
        if (!body.ok) throw new Error(`telegram.send: ${body.description ?? `HTTP ${res.status}`}`);
        return [{ json: { sent: true, kind: "document", filename: params.filename } }];
      }

      if (!params.text) throw new Error("telegram.send: nothing to send — give me text, or a filename plus binary input");
      const res = await fetch(`${api}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: params.chatId, text: params.text }),
      });
      const body = (await res.json()) as { ok: boolean; description?: string };
      if (!body.ok) throw new Error(`telegram.send: ${body.description ?? `HTTP ${res.status}`}`);
      return [{ json: { sent: true, kind: "message" } }];
    },
  };
}
