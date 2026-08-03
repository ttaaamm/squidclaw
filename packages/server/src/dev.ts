import "dotenv/config";
import { listNodes } from "@squidclaw/kernel";
import { TelegramSurface } from "@squidclaw/surfaces";
import { Scheduler, WebhookServer } from "@squidclaw/reflexes";
import { DashboardServer } from "@squidclaw/canvas";
import { bootAgent, dashboardSources, habitRunner, handleCommand, requireEnv } from "./boot.js";

requireEnv("TELEGRAM_BOT_TOKEN");

const booted = await bootAgent();
const { agent, flows, reflexes, via, mcp } = booted;

/** Where the agent speaks when nobody asked it anything — reflex reports, healing news. */
const homeChat = process.env.SQUIDCLAW_HOME_CHAT;
let surface: TelegramSurface;

const notify = (message: string) => {
  console.log(message);
  if (homeChat) void surface.bot.api.sendMessage(homeChat, message).catch(() => {});
};

const runHabit = habitRunner(booted, notify);

surface = new TelegramSurface(process.env.TELEGRAM_BOT_TOKEN!, async (chatId, text, progress) => {
  return handleCommand(text, booted, chatId) ?? (await agent.handleMessage(text, chatId, progress));
});
await surface.start();

const scheduler = new Scheduler(reflexes, runHabit, {
  say: (m) => notify(m),
  onFire: (r) => notify(`⏰ reflex "${r.reflex}" fired — ${r.status}${r.detail ? `: ${r.detail}` : ""}`),
});
scheduler.start();

const hooks = new WebhookServer(reflexes, runHabit, {
  token: process.env.SQUIDCLAW_WEBHOOK_TOKEN,
  onFire: (name, status, detail) => notify(`🪝 hook "${name}" — ${status}${detail ? `: ${detail}` : ""}`),
});
const port = await hooks.listen(Number(process.env.SQUIDCLAW_PORT ?? 4100));

const dashboard = new DashboardServer(dashboardSources(booted), { token: process.env.SQUIDCLAW_UI_TOKEN });
const uiPort = await dashboard.listen(Number(process.env.SQUIDCLAW_UI_PORT ?? 4200));

console.log(`🫀 SquidClaw heartbeat: listening on Telegram (long-polling). Ctrl+C to stop.`);
console.log(`   thinking via: ${via} · tools: ${listNodes().length}${mcp.registered.length ? ` (${mcp.registered.length} via MCP)` : ""}`);
console.log(`   habits: ${flows.promoted().length} learned, ${flows.drafts().length} awaiting your yes`);
console.log(`   reflexes: ${reflexes.enabled().length} armed · hooks on http://127.0.0.1:${port}`);
console.log(`   🧠 its mind: http://127.0.0.1:${uiPort}`);
if (!homeChat) console.log(`   (set SQUIDCLAW_HOME_CHAT to a chat id to get reflex + healing reports on Telegram)`);
for (const [server, err] of Object.entries(mcp.failed)) console.log(`   ⚠️  MCP "${server}" failed: ${err}`);
