import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { ChatSurface, MessageHandler } from "./surface.js";

export interface TelegramSurfaceOptions {
  botInfo?: UserFromGetMe;
  /** Silence before the first progress note — quick answers should send nothing extra. */
  progressAfterMs?: number;
  /** Minimum gap between notes, so a busy task doesn't flood the chat. */
  progressGapMs?: number;
}

/** Telegram's typing indicator lives ~5s; refresh it a little faster than that. */
const TYPING_REFRESH_MS = 4500;

export class TelegramSurface implements ChatSurface {
  readonly bot: Bot;
  private progressAfterMs: number;
  private progressGapMs: number;

  constructor(token: string, onMessage: MessageHandler, opts: TelegramSurfaceOptions = {}) {
    this.progressAfterMs = opts.progressAfterMs ?? 6_000;
    this.progressGapMs = opts.progressGapMs ?? 8_000;
    this.bot = opts.botInfo ? new Bot(token, { botInfo: opts.botInfo }) : new Bot(token);

    this.bot.on("message:text", async (ctx) => {
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
        const reply = await onMessage(String(ctx.chat.id), ctx.message.text, progress);
        await ctx.reply(reply);
      } catch (err) {
        await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
      } finally {
        clearInterval(heartbeat);
      }
    });
  }

  async start(): Promise<void> {
    void this.bot.start();
  }

  async stop(): Promise<void> {
    await this.bot.stop();
  }
}
