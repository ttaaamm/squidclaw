import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Bot, type Context } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { ChatSurface, MessageHandler } from "./surface.js";

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

  /** Shared rhythm for every message kind: typing, progress, answer, apologise. */
  private async handleWith(ctx: Context, produceText: () => Promise<string>): Promise<void> {
    // Show life immediately, and keep showing it for as long as the work runs.
    const typing = () => void ctx.replyWithChatAction("typing").catch(() => {});
    typing();
    const heartbeat = setInterval(typing, TYPING_REFRESH_MS);

    const started = Date.now();
    let lastNote = 0;
    const progress = (note: string) => {
      const now = Date.now();
      // Say something only when it's genuinely taking a while — and not too often.
      if (now - started < this.progressAfterMs) return;
      if (now - lastNote < this.progressGapMs) return;
      lastNote = now;
      void ctx.reply(`⚙️ ${note}`).catch(() => {});
    };

    try {
      const text = await produceText();
      const reply = await this.onMessage(String(ctx.chat!.id), text, progress);
      await ctx.reply(reply);
    } catch (err) {
      await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
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
