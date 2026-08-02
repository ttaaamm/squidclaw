import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import type { ChatSurface, MessageHandler } from "./surface.js";

/**
 * A terminal face. Same contract as Telegram — the agent never knows the difference.
 * Useful for proving the heartbeat without any messenger account.
 */
export class CliSurface implements ChatSurface {
  private rl?: ReturnType<typeof createInterface>;

  constructor(private onMessage: MessageHandler) {}

  async start(): Promise<void> {
    this.rl = createInterface({ input: stdin, output: stdout });
    console.log('Talk to SquidClaw. Type "exit" to stop.\n');
    for (;;) {
      const text = (await this.rl.question("you › ")).trim();
      if (!text) continue;
      if (text === "exit") break;
      try {
        console.log(`\nsquidclaw › ${await this.onMessage("cli", text)}\n`);
      } catch (err) {
        console.log(`\n⚠️ ${err instanceof Error ? err.message : String(err)}\n`);
      }
    }
    await this.stop();
  }

  async stop(): Promise<void> {
    this.rl?.close();
  }
}
