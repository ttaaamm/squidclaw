import "dotenv/config";
import { join } from "node:path";
import { listNodes } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { TelegramSurface, WhatsAppSurface } from "@squidclaw/surfaces";
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

surface = new TelegramSurface(process.env.TELEGRAM_BOT_TOKEN!, (chatId, text, progress) =>
  platform.handle("telegram", chatId, text, progress),
);
await surface.start();

// The second face: same platform, same tenants — /join works from WhatsApp too.
let whatsapp: WhatsAppSurface | undefined;
if (process.env.SQUIDCLAW_WHATSAPP === "1") {
  whatsapp = new WhatsAppSurface(
    (chatId, text, progress) => platform.handle("whatsapp", chatId, text, progress),
    {
      authDir: join(root, "whatsapp"),
      onEvent: (event) => {
        console.log(`[whatsapp] ${event}`);
        // The pairing QR must reach a human: render it in the admin's Telegram too.
        if (event.startsWith("scan to pair") && admins.length) {
          const chat = admins[0].replace(/^telegram:/, "");
          void surface.bot.api
            .sendMessage(chat, "📱 WhatsApp pairing needed — open WhatsApp → Linked Devices → scan the QR in the server logs (journalctl -u squidclaw-serve).")
            .catch(() => {});
        }
      },
    },
  );
  await whatsapp.start();
}

const warmed = await platform.warmAll();
const hooks = platform.hooksServer(process.env.SQUIDCLAW_WEBHOOK_TOKEN);
const port = Number(process.env.SQUIDCLAW_PORT ?? 4100);
hooks.listen(port, "127.0.0.1");

console.log(`🐙 SquidClaw platform: listening on Telegram. Ctrl+C to stop.`);
console.log(`   thinking via: ${via} · shared tools: ${listNodes().length}`);
console.log(`   tenants: ${platform.tenants.all().length} (${warmed} warm) · hooks on http://127.0.0.1:${port}`);
console.log(`   faces: telegram${whatsapp ? " + whatsapp" : ""} (SQUIDCLAW_WHATSAPP=1 enables whatsapp)`);
if (!admins.length) {
  console.log(`   ⚠️  SQUIDCLAW_ADMIN_CHAT is unset — nobody can run /tenant commands.`);
  console.log(`      Set it to your Telegram chat id (message the bot, check the logs, or use @userinfobot).`);
}
