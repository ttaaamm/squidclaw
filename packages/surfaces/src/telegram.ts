import { Bot } from "grammy";
import type { UserFromGetMe } from "grammy/types";
import type { ChatSurface, MessageHandler } from "./surface.js";

export class TelegramSurface implements ChatSurface {
  readonly bot: Bot;

  constructor(token: string, onMessage: MessageHandler, botInfo?: UserFromGetMe) {
    this.bot = botInfo ? new Bot(token, { botInfo }) : new Bot(token);
    this.bot.on("message:text", async (ctx) => {
      try {
        const reply = await onMessage(String(ctx.chat.id), ctx.message.text);
        await ctx.reply(reply);
      } catch (err) {
        await ctx.reply(`⚠️ ${err instanceof Error ? err.message : String(err)}`);
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
