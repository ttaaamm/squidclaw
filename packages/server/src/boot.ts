import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes } from "@squidclaw/nodes";
import { Brains, loadBrainsConfig } from "@squidclaw/brains";
import { ConversationStore, SemanticMemory, registerMemoryNodes } from "@squidclaw/memory";
import { Agent } from "@squidclaw/agent";

/** Assembles the whole organism from a workspace directory. One body, many faces. */
export function bootAgent(): { agent: Agent; workspace: string } {
  const workspace = process.env.SQUIDCLAW_WORKSPACE ?? join(process.cwd(), "workspace");

  const memory = new SemanticMemory(join(workspace, "memory"));
  registerBuiltinNodes();
  registerMemoryNodes(memory);

  const agent = new Agent({
    brains: new Brains(loadBrainsConfig(join(workspace, "BRAINS.yaml"))),
    journal: new Journal(join(workspace, "journal", "executions.db")),
    conversation: new ConversationStore(join(workspace, "journal", "conversation.db")),
    memory,
    tenantId: "dev",
    innerMe: readFileSync(join(workspace, "INNERME.md"), "utf8"),
  });

  return { agent, workspace };
}

export function requireEnv(...names: string[]): void {
  for (const name of names) {
    if (!process.env[name]) {
      console.error(`${name} missing — copy .env.example to .env and fill it in`);
      process.exit(1);
    }
  }
}
