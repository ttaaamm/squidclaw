import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains, loadBrainsConfig } from "@squidclaw/brains";
import { Agent } from "@squidclaw/agent";
import { TelegramSurface } from "@squidclaw/surfaces";

const WORKSPACE = process.env.SQUIDCLAW_WORKSPACE ?? join(process.cwd(), "workspace");

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("TELEGRAM_BOT_TOKEN missing — copy .env.example to .env and fill it in");
  process.exit(1);
}
if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY missing — copy .env.example to .env and fill it in");
  process.exit(1);
}

registerBuiltinNodes();
const journal = new Journal(join(WORKSPACE, "journal", "executions.db"));
const brains = new Brains(loadBrainsConfig(join(WORKSPACE, "BRAINS.yaml")));
const innerMe = readFileSync(join(WORKSPACE, "INNERME.md"), "utf8");
const agent = new Agent({ brains, journal, tenantId: "dev", innerMe });

const surface = new TelegramSurface(token, (_chatId, text) => agent.handleMessage(text));
await surface.start();

console.log("🫀 SquidClaw heartbeat: listening on Telegram (long-polling). Ctrl+C to stop.");
