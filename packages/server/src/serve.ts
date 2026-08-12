import "dotenv/config";
import { join } from "node:path";
import { listNodes } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { loadPlugins } from "@squidclaw/sdk";
import { Journal, getNode, registerNode } from "@squidclaw/kernel";
import { FlowStore } from "@squidclaw/agent";
import { ReflexStore } from "@squidclaw/reflexes";
import { SemanticMemory } from "@squidclaw/memory";
import { DashboardServer } from "@squidclaw/canvas";
import { TelegramSurface, WhatsAppSurface } from "@squidclaw/surfaces";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { chooseMind, habitRunner, requireEnv } from "./boot.js";
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

// Plugins: anything under <workspace>/plugins joins the arsenal — its tools
// become nodes/mind-tools/flow-steps, its surfaces become new doors. One
// broken plugin is reported by name, never fatal.
const loadedPlugins = await loadPlugins(
  join(root, "plugins"),
  { workspace: root, env: process.env, log: (m) => console.log(`🔌 ${m}`) },
  (pluginName) => (chatId, text, progress) => platform.handle(`plugin:${pluginName}`, chatId, text, progress),
);
for (const node of loadedPlugins.nodes) registerNode(node);
for (const [name, why] of Object.entries(loadedPlugins.failed)) console.error(`🔌 plugin ${name} failed: ${why}`);

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
  plugins: { plugins: loadedPlugins.plugins, failed: loadedPlugins.failed },
  // The deep mind: whole tasks to the Claude Code harness, tools MCP-bridged.
  // Default on when thinking via CLI; SQUIDCLAW_DEEP=0 opts out.
  deep:
    via === "cli" && process.env.SQUIDCLAW_DEEP !== "0"
      ? {
          shimPath: join(dirname(fileURLToPath(import.meta.url)), "mcp-shim.mjs"),
          model: process.env.SQUIDCLAW_DEEP_MODEL ?? "sonnet",
        }
      : undefined,
  // Channel docking's other half: an unsolicited push (a reflex firing, a
  // commitment) goes wherever the human is actually standing right now —
  // not "the first Telegram binding ever made". Falls back to the old
  // behavior if nothing's been heard from this tenant yet.
  notify: (tenantId, message) => {
    console.log(`[${tenantId}] ${message}`);
    const active = platform.lastActive(tenantId);
    const target = active ?? platform.tenants.bindings(tenantId).find((b) => b.surface === "telegram");
    if (!target) return;
    if (target.surface === "whatsapp" && whatsapp) {
      void whatsapp.send(target.chatId, message).catch(() => {});
    } else {
      void surface.bot.api.sendMessage(target.chatId, message).catch(() => {});
    }
  },
});

surface = new TelegramSurface(
  process.env.TELEGRAM_BOT_TOKEN!,
  (chatId, text, progress) => platform.handle("telegram", chatId, text, progress),
  {
    // Voice notes become words before the mind wakes — one thinking turn.
    transcribe: async (path) => {
      const ears = getNode("audio.transcribe");
      if (!ears) throw new Error("no ears registered");
      const out = await ears.run({ path }, [], { tenantId: "surface" });
      return String(out[0]?.json?.text ?? "");
    },
  },
);
await surface.start();
for (const pluginSurface of loadedPlugins.surfaces) await pluginSurface.start();

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
    // Running a habit from the canvas takes the same road as a webhook firing:
    // one runner, one quota, one journal — so a flow behaves identically
    // whether a human pressed the button or a reflex fired it.
    // A warm organism registers its habits once, at boot. Without this, a flow
    // promoted through the canvas stays invisible to the agent until restart —
    // so creating a flow and running it, the whole point of the UI, would fail.
    refresh: async (tenantId) => {
      if (!tenantId) return;
      const organism = await platform.organismFor(tenantId);
      organism.agent.registerHabits();
    },
    // Web chat. Routed through platform.handle exactly like Telegram, so the
    // canvas inherits everything for free: session lanes, elicitation, quotas,
    // channel docking. Bind first — the turn router resolves a tenant from
    // (surface, chatId), and the tenant's own id is a stable web chatId.
    chat: async (tenantId, text, page, onDelta) => {
      if (!tenantId) throw new Error("the admin master view has no tenant to talk to — sign in with /canvas");
      const t0 = Date.now();
      platform.tenants.bind("web", tenantId, tenantId);
      const withPage = page && page !== "/" ? `${text}\n\n[the human is looking at ${page} in the canvas]` : text;
      const reply = await platform.handle("web", tenantId, withPage, undefined, onDelta);
      if (process.env.SQUIDCLAW_TIMING === "1") {
        console.log(`[timing] chat handle=${Date.now() - t0}ms tenant=${tenantId}`);
      }
      return reply;
    },
    run: async (tenantId, name, args) => {
      if (!tenantId) throw new Error("the admin master view has no tenant to run as — sign in with /canvas");
      const denied = platform.tenants.checkQuota(tenantId, "habit");
      if (denied) throw new Error(denied);
      const organism = await platform.organismFor(tenantId);
      const result = await habitRunner(organism, (m) => console.log(`[${tenantId}] ${m}`))(name, args);
      platform.tenants.record(tenantId, "habit");
      return result;
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
