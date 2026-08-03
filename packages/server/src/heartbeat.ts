import "dotenv/config";
import { listNodes } from "@squidclaw/kernel";
import { CliSurface } from "@squidclaw/surfaces";
import { bootAgent, handleCommand } from "./boot.js";

const booted = await bootAgent();
const { agent, vibes, flows, via, mcp } = booted;

console.log(`🫀 SquidClaw heartbeat — terminal surface`);
console.log(`   thinking via: ${via}${via === "cli" ? " (your Claude subscription — no API key needed)" : ""}`);
console.log(`   tools: ${listNodes().length}${mcp.registered.length ? ` (${mcp.registered.length} via MCP)` : ""}`);
console.log(`   habits: ${flows.promoted().length} learned, ${flows.drafts().length} awaiting your yes`);
for (const [server, err] of Object.entries(mcp.failed)) console.log(`   ⚠️  MCP "${server}" failed: ${err}`);
console.log(`   vibe: ${vibes.current("cli")} · /help for commands\n`);

await new CliSurface(async (chatId, text) => {
  return handleCommand(text, booted, chatId) ?? (await agent.handleMessage(text, chatId));
}).start();
