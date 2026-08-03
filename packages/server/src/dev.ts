import "dotenv/config";
import { listNodes } from "@squidclaw/kernel";
import { TelegramSurface } from "@squidclaw/surfaces";
import { bootAgent, handleCommand, requireEnv } from "./boot.js";

requireEnv("TELEGRAM_BOT_TOKEN");

const { agent, vibes, via, mcp } = await bootAgent();

const surface = new TelegramSurface(process.env.TELEGRAM_BOT_TOKEN!, async (chatId, text) => {
  return handleCommand(text, vibes, chatId) ?? (await agent.handleMessage(text, chatId));
});
await surface.start();

console.log(`🫀 SquidClaw heartbeat: listening on Telegram (long-polling). Ctrl+C to stop.`);
console.log(`   thinking via: ${via} · tools: ${listNodes().length}${mcp.registered.length ? ` (${mcp.registered.length} via MCP)` : ""}`);
for (const [server, err] of Object.entries(mcp.failed)) console.log(`   ⚠️  MCP "${server}" failed: ${err}`);
