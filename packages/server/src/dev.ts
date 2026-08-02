import "dotenv/config";
import { TelegramSurface } from "@squidclaw/surfaces";
import { bootAgent, requireEnv } from "./boot.js";

requireEnv("TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY");

const { agent } = bootAgent();
const surface = new TelegramSurface(process.env.TELEGRAM_BOT_TOKEN!, (chatId, text) =>
  agent.handleMessage(text, chatId),
);
await surface.start();

console.log("🫀 SquidClaw heartbeat: listening on Telegram (long-polling). Ctrl+C to stop.");
