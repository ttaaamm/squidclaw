import "dotenv/config";
import { listNodes } from "@squidclaw/kernel";
import { CliSurface } from "@squidclaw/surfaces";
import { Scheduler, WebhookServer } from "@squidclaw/reflexes";
import { DashboardServer } from "@squidclaw/canvas";
import { bootAgent, dashboardSources, habitRunner, handleCommand } from "./boot.js";

const booted = await bootAgent();
const { agent, vibes, flows, reflexes, via, mcp } = booted;

const notify = (message: string) => console.log(`\n${message}\n`);
const runHabit = habitRunner(booted, notify);

const scheduler = new Scheduler(reflexes, runHabit, {
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

console.log(`🫀 SquidClaw heartbeat — terminal surface`);
console.log(`   thinking via: ${via}${via === "cli" ? " (your Claude subscription — no API key needed)" : ""}`);
console.log(`   tools: ${listNodes().length}${mcp.registered.length ? ` (${mcp.registered.length} via MCP)` : ""}`);
console.log(`   habits: ${flows.promoted().length} learned, ${flows.drafts().length} awaiting your yes`);
console.log(`   reflexes: ${reflexes.enabled().length} armed · hooks on http://127.0.0.1:${port}`);
console.log(`   🧠 its mind: http://127.0.0.1:${uiPort}`);
for (const [server, err] of Object.entries(mcp.failed)) console.log(`   ⚠️  MCP "${server}" failed: ${err}`);
console.log(`   vibe: ${vibes.current("cli")} · /help for commands\n`);

await new CliSurface(async (chatId, text) => {
  return handleCommand(text, booted, chatId) ?? (await agent.handleMessage(text, chatId));
}).start();

scheduler.stop();
await hooks.close();

await dashboard.close();
