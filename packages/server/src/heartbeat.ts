import "dotenv/config";
import { CliSurface } from "@squidclaw/surfaces";
import { bootAgent, requireEnv } from "./boot.js";

requireEnv("ANTHROPIC_API_KEY");

const { agent } = bootAgent();

console.log("🫀 SquidClaw heartbeat — terminal surface\n");
await new CliSurface((chatId, text) => agent.handleMessage(text, chatId)).start();
