import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bot, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { ChatSurface, MessageHandler } from "./surface.js";
import { chunkMessage } from "./chunk.js";

export interface TelegramSurfaceOptions {
  botInfo?: UserFromGetMe;
  /** Silence before the first progress note — quick answers should send nothing extra. */
  progressAfterMs?: number;
  /** Minimum gap between notes, so a busy task doesn't flood the chat. */
  progressGapMs?: number;
  /** Where incoming media lands for the agent's senses to reach. */
  mediaDir?: string;
  /** Injectable download for tests. */
  download?: (fileId: string, dest: string) => Promise<string>;
  /**
   * Hear a voice note BEFORE the mind wakes: the surface transcribes and
   * hands the agent plain words — one thinking turn instead of two. When
   * absent (or failing), the old path remains: the agent is told where the
   * audio lives and reaches for its own ears.
   */
  transcribe?: (path: string) => Promise<string>;
}

/** Telegram's typing indicator lives ~5s; refresh it a little faster than that. */
const TYPING_REFRESH_MS = 4500;

export class TelegramSurface implements ChatSurface {
  readonly bot: Bot;
  private progressAfterMs: number;
  private progressGapMs: number;
  private mediaDir: string;
  private download: (fileId: string, dest: string) => Promise<string>;

  constructor(token: string, onMessage: MessageHandler, opts: TelegramSurfaceOptions = {}) {
    this.progressAfterMs = opts.progressAfterMs ?? 6_000;
    this.progressGapMs = opts.progressGapMs ?? 8_000;
    this.mediaDir = opts.mediaDir ?? join(tmpdir(), "squidclaw-media");
    this.bot = opts.botInfo ? new Bot(token, { botInfo: opts.botInfo }) : new Bot(token);

    this.download =
      opts.download ??
      (async (fileId, dest) => {
        const file = await this.bot.api.getFile(fileId);
        const res = await fetch(`https://api.telegram.org/file/bot${token}/${file.file_path}`);
        if (!res.ok) throw new Error(`media download failed: HTTP ${res.status}`);
        mkdirSync(this.mediaDir, { recursive: true });
        writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
        return dest;
      });

    /**
     * Media becomes something the agent can sense: the file lands on disk and
     * the message tells the agent where, so it reaches for vision.look or
     * audio.transcribe like any other tool.
     */
    this.bot.on("message:photo", (ctx) =>
      this.handleWith(ctx, async () => {
        const best = ctx.message.photo.at(-1)!; // largest rendition
        const path = await this.download(best.file_id, join(this.mediaDir, `${best.file_unique_id}.jpg`));
        const caption = ctx.message.caption ?? "";
        return `${caption}\n\n[The human sent a photo. It is saved at ${path} — use vision.look to see it before answering.]`.trim();
      }),
    );

    this.bot.on(["message:voice", "message:audio"], (ctx) =>
      this.handleWith(ctx, async () => {
        const media = ctx.message.voice ?? ctx.message.audio!;
        const path = await this.download(media.file_id, join(this.mediaDir, `${media.file_unique_id}.ogg`));
        // Hear first, think once: transcribe at the surface so the mind
        // receives words, not homework.
        if (opts.transcribe) {
          try {
            const heard = await opts.transcribe(path);
            if (heard.trim()) return `🎙️ (a voice note — they said): ${heard.trim()}`;
          } catch { /* deaf moment — fall back to the agent's own ears */ }
        }
        return `[The human sent a voice note. It is saved at ${path} — use audio.transcribe to hear it, then answer what they said.]`;
      }),
    );

    this.bot.on("message:document", (ctx) =>
      this.handleWith(ctx, async () => {
        const doc = ctx.message.document;
        const name = doc.file_name ?? `${doc.file_unique_id}.bin`;
        const path = await this.download(doc.file_id, join(this.mediaDir, `${doc.file_unique_id}-${name}`));
        const caption = ctx.message.caption ?? "";
        return `${caption}\n\n[The human sent a file "${name}", saved at ${path}.]`.trim();
      }),
    );

    this.bot.on("message:text", (ctx) => this.handleWith(ctx, async () => ctx.message!.text!));

    this.onMessage = onMessage;
  }

  private onMessage!: MessageHandler;

  /**
   * Shared rhythm for every message kind: typing, progress, answer, apologise.
   *
   * Progress is a DRAFT, not a stack: the first note becomes one visible
   * "working…" message that edits in place as the work moves, then quietly
   * disappears when the real answer lands as a fresh message (fresh, so the
   * human still gets a notification — edits are silent on Telegram).
   */
  private async handleWith(ctx: Context, produceText: () => Promise<string>): Promise<void> {
    // Show life immediately, and keep showing it for as long as the work runs.
    const typing = () => void ctx.replyWithChatAction("typing").catch(() => {});
    typing();
    const heartbeat = setInterval(typing, TYPING_REFRESH_MS);

    const chatId = ctx.chat!.id;
    const started = Date.now();
    let lastNote = 0;
    let draft: { id: number; text: string } | null = null;
    let chain: Promise<void> = Promise.resolve(); // edits stay in order

    const progress = (note: string) => {
      const now = Date.now();
      // Say something only when it's genuinely taking a while — and not too often.
      if (now - started < this.progressAfterMs) return;
      if (now - lastNote < this.progressGapMs) return;
      lastNote = now;
      const text = `⚙️ ${note}`;
      chain = chain.then(async () => {
        try {
          if (!draft) {
            const m = await ctx.reply(text);
            if (m && (m as { message_id?: number }).message_id) draft = { id: m.message_id, text };
          } else if (draft.text !== text) {
            await ctx.api.editMessageText(chatId, draft.id, text);
            draft.text = text;
          }
        } catch { /* progress is a courtesy, never a failure */ }
      });
    };

    const clearDraft = async () => {
      await chain;
      if (draft) {
        await ctx.api.deleteMessage(chatId, draft.id).catch(() => {});
        draft = null;
      }
    };

    try {
      const text = await produceText();
      const reply = await this.onMessage(String(chatId), text, progress);
      await clearDraft();
      if (!reply) return; // the flow spoke for itself
      // Telegram rejects anything over ~4096 chars outright — a long
      // legitimate answer must arrive as several messages, not vanish.
      for (const chunk of chunkMessage(reply)) await ctx.reply(chunk);
    } catch (err) {
      await clearDraft();
      const message = err instanceof Error ? err.message : String(err);
      for (const chunk of chunkMessage(`⚠️ ${message}`)) await ctx.reply(chunk);
    } finally {
      clearInterval(heartbeat);
    }
  }

  async start(): Promise<void> {
    void this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
