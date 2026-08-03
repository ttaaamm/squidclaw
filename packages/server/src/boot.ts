import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes, registerMcpServers, type McpConfig } from "@squidclaw/nodes";
import { Brains, CliBrain, loadBrainsConfig, type Mind } from "@squidclaw/brains";
import { ConversationStore, SemanticMemory, registerMemoryNodes } from "@squidclaw/memory";
import { Agent, VibeState, loadVibes } from "@squidclaw/agent";

/**
 * Two doors to the same mind.
 *
 * `cli` runs on the human's Claude subscription — no API key, nothing metered.
 * `api` uses ANTHROPIC_API_KEY with tier routing and fallback. Default to
 * whichever is actually available, preferring the key when both are.
 */
export function chooseMind(workspace: string): { mind: Mind; via: "api" | "cli" } {
  const wanted = process.env.SQUIDCLAW_BRAIN;
  const hasKey = !!process.env.ANTHROPIC_API_KEY;

  if (wanted === "cli" || (!wanted && !hasKey)) {
    return { mind: new CliBrain(), via: "cli" };
  }
  return { mind: new Brains(loadBrainsConfig(join(workspace, "BRAINS.yaml"))), via: "api" };
}

export interface Booted {
  agent: Agent;
  vibes: VibeState;
  workspace: string;
  via: "api" | "cli";
  mcp: { registered: string[]; failed: Record<string, string> };
}

/** Assembles the whole organism from a workspace directory. One body, many faces. */
export async function bootAgent(): Promise<Booted> {
  const workspace = process.env.SQUIDCLAW_WORKSPACE ?? join(process.cwd(), "workspace");

  const memory = new SemanticMemory(join(workspace, "memory"));
  registerBuiltinNodes();
  registerMemoryNodes(memory);

  // Borrowed tools: anything in mcp.json becomes a node, same as a native one.
  let mcp: Booted["mcp"] = { registered: [], failed: {} };
  const mcpPath = join(workspace, "mcp.json");
  if (existsSync(mcpPath)) {
    mcp = await registerMcpServers(JSON.parse(readFileSync(mcpPath, "utf8")) as McpConfig);
  }

  const { mind, via } = chooseMind(workspace);
  const vibesPath = join(workspace, "VIBES.yaml");
  const vibes = new VibeState(loadVibes(existsSync(vibesPath) ? vibesPath : undefined));

  const agent = new Agent({
    brains: mind,
    journal: new Journal(join(workspace, "journal", "executions.db")),
    conversation: new ConversationStore(join(workspace, "journal", "conversation.db")),
    memory,
    vibes,
    tenantId: "dev",
    innerMe: readFileSync(join(workspace, "INNERME.md"), "utf8"),
  });

  return { agent, vibes, workspace, via, mcp };
}

export function requireEnv(...names: string[]): void {
  for (const name of names) {
    if (!process.env[name]) {
      console.error(`${name} missing — copy .env.example to .env and fill it in`);
      process.exit(1);
    }
  }
}

/** Chat commands that belong to the body, not the mind. */
export function handleCommand(input: string, vibes: VibeState, chatId: string): string | null {
  const [cmd, arg] = input.trim().split(/\s+/, 2);
  if (cmd === "/vibe") {
    if (!arg) return `Current vibe: ${vibes.current(chatId)}. Available: ${vibes.list().join(", ")}`;
    return vibes.set(chatId, arg)
      ? `Vibe set to ${arg}.`
      : `No such vibe "${arg}". Available: ${vibes.list().join(", ")}`;
  }
  return null;
}
