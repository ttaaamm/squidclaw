import "dotenv/config";
import { join } from "node:path";
import { listNodes } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Journal } from "@squidclaw/kernel";
import { FlowStore } from "@squidclaw/agent";
import { ReflexStore } from "@squidclaw/reflexes";
import { SemanticMemory } from "@squidclaw/memory";
import { DashboardServer } from "@squidclaw/canvas";
import { TelegramSurface, WhatsAppSurface } from "@squidclaw/surfaces";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
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
  publicUrl: process.env.SQUIDCLAW_PUBLIC_URL,
  root,
  mind,
  via,
  adminChats: admins,
  // The deep mind: whole tasks to the Claude Code harness, tools MCP-bridged.
  // Default on when thinking via CLI; SQUIDCLAW_DEEP=0 opts out.
  deep:
    via === "cli" && process.env.SQUIDCLAW_DEEP !== "0"
      ? {
          shimPath: join(dirname(fileURLToPath(import.meta.url)), "mcp-shim.mjs"),
          model: process.env.SQUIDCLAW_DEEP_MODEL ?? "sonnet",
        }
      : undefined,
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
const hooks = platform.hooksServer(process.env.SQUIDCLAW_WEBHOOK_TOKEN, process.env.SQUIDCLAW_PARTNER_KEY);
const port = Number(process.env.SQUIDCLAW_PORT ?? 4100);
hooks.listen(port, "127.0.0.1");

// The canvas, multi-tenant: /canvas in chat (or Preplix SSO) mints a one-time
// link; sessions scope every answer to one tenant's mind. The admin token
// still opens the master view of the shared workspace.
const adminMemory = new SemanticMemory(join(root, "memory"));
const dashboard = new DashboardServer(
  {
    journal: new Journal(join(root, "journal", "executions.db")),
    flows: new FlowStore(join(root, "flows")),
    reflexes: new ReflexStore(join(root, "reflexes")),
    memories: () => adminMemory.all(),
    mind: { via, tools: listNodes().length },
  },
  {
    token: process.env.SQUIDCLAW_UI_TOKEN,
    auth: {
      redeemCode: (code) => platform.logins.redeemCode(code),
      createSession: (tenantId) => platform.logins.createSession(tenantId),
      sessionTenant: (sid) => platform.logins.sessionTenant(sid),
      sourcesFor: (tenantId) => platform.sourcesFor(tenantId),
    },
  },
);
const uiPort = await dashboard.listen(Number(process.env.SQUIDCLAW_UI_PORT ?? 4200));

console.log(`🐙 SquidClaw platform: listening on Telegram. Ctrl+C to stop.`);
console.log(`   thinking via: ${via} · shared tools: ${listNodes().length}`);
console.log(`   tenants: ${platform.tenants.all().length} (${warmed} warm) · hooks on http://127.0.0.1:${port}`);
console.log(`   canvas: http://127.0.0.1:${uiPort} — /canvas in chat mints sign-in links`);
console.log(`   faces: telegram${whatsapp ? " + whatsapp" : ""} (SQUIDCLAW_WHATSAPP=1 enables whatsapp)`);
if (!admins.length) {
  console.log(`   ⚠️  SQUIDCLAW_ADMIN_CHAT is unset — nobody can run /tenant commands.`);
  console.log(`      Set it to your Telegram chat id (message the bot, check the logs, or use @userinfobot).`);
}
