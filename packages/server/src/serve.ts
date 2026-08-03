import "dotenv/config";
import { join } from "node:path";
import { listNodes } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { TelegramSurface } from "@squidclaw/surfaces";
import { chooseMind, requireEnv } from "./boot.js";
import { Platform } from "./platform.js";

/**
 * The platform runner: many tenants, one process.
 *
 * `npm run dev` stays the single-user mode (your own agent, no accounts).
 * This is the service — invites, bindings, quotas, per-tenant everything.
 */
requireEnv("TELEGRAM_BOT_TOKEN");

const root = process.env.SQUIDCLAW_WORKSPACE ?? join(process.cwd(), "workspace");
registerBuiltinNodes();
const { mind, via } = chooseMind(root);

const admins = (process.env.SQUIDCLAW_ADMIN_CHAT ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

let surface: TelegramSurface;

const platform = new Platform({
  root,
  mind,
  via,
  adminChats: admins,
  notify: (tenantId, message) => {
    console.log(`[${tenantId}] ${message}`);
    const chat = platform.tenants.bindings(tenantId).find((b) => b.surface === "telegram");
    if (chat) void surface.bot.api.sendMessage(chat.chatId, message).catch(() => {});
  },
});

surface = new TelegramSurface(process.env.TELEGRAM_BOT_TOKEN!, (chatId, text) =>
  platform.handle("telegram", chatId, text),
);
await surface.start();

const warmed = await platform.warmAll();
const hooks = platform.hooksServer(process.env.SQUIDCLAW_WEBHOOK_TOKEN);
const port = Number(process.env.SQUIDCLAW_PORT ?? 4100);
hooks.listen(port, "127.0.0.1");

console.log(`🐙 SquidClaw platform: listening on Telegram. Ctrl+C to stop.`);
console.log(`   thinking via: ${via} · shared tools: ${listNodes().length}`);
console.log(`   tenants: ${platform.tenants.all().length} (${warmed} warm) · hooks on http://127.0.0.1:${port}`);
if (!admins.length) {
  console.log(`   ⚠️  SQUIDCLAW_ADMIN_CHAT is unset — nobody can run /tenant commands.`);
  console.log(`      Set it to your Telegram chat id (message the bot, check the logs, or use @userinfobot).`);
}
