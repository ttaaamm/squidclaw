import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Journal } from "@squidclaw/kernel";
import { registerBuiltinNodes, registerMcpServers, type McpConfig } from "@squidclaw/nodes";
import { Brains, CliBrain, loadBrainsConfig, type Mind } from "@squidclaw/brains";
import { ConversationStore, SemanticMemory, registerMemoryNodes } from "@squidclaw/memory";
import { Agent, FlowStore, VibeState, heal, loadVibes } from "@squidclaw/agent";
import { ReflexStore, Scheduler, WebhookServer } from "@squidclaw/reflexes";
import { getNode, listNodes, type ExecutionRecord } from "@squidclaw/kernel";

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
  flows: FlowStore;
  reflexes: ReflexStore;
  journal: Journal;
  memory: SemanticMemory;
  workspace: string;
  via: "api" | "cli";
  mcp: { registered: string[]; failed: Record<string, string> };
}

/**
 * Runs a habit, and if it stumbles, tries to pick it back up.
 *
 * Transient trouble gets retried quietly; a genuinely broken habit reaches a
 * human in plain language instead of dying in a log nobody reads.
 */
export function habitRunner(booted: Booted, notify: (message: string) => void) {
  return async (flowName: string, args: Record<string, unknown>): Promise<unknown> => {
    const node = getNode(`flow.${flowName}`);
    if (!node) throw new Error(`no promoted habit called "${flowName}"`);

    const attempt = async () => node.run(args, [], { tenantId: "dev" });
    try {
      return await attempt();
    } catch (err) {
      const [failed] = booted.journal.list({ tenantId: "dev", limit: 1 });
      const record: ExecutionRecord = failed ?? {
        id: "unknown", tenantId: "dev", kind: "flow", status: "error",
        graph: { nodes: [], edges: [] }, startedAt: new Date().toISOString(),
        steps: [{
          nodeId: "n1", node: flowName, params: args, input: [], output: [],
          status: "error", error: String(err),
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        }],
      };

      let output: unknown;
      const result = await heal(
        record,
        // A retry that fails must report a failed run, not throw — otherwise
        // healing stops at the first attempt and nobody ever gets told.
        async (): Promise<ExecutionRecord> => {
          try {
            output = await attempt();
            return { ...record, status: "ok", steps: [] };
          } catch (retryErr) {
            const latest = booted.journal.list({ tenantId: "dev", limit: 1 })[0];
            if (latest?.status === "error") return latest;
            return {
              ...record,
              steps: record.steps.map((s) => ({ ...s, error: String(retryErr) })),
            };
          }
        },
        { notify: (m) => notify(`⚠️ habit "${flowName}": ${m}`) },
      );

      if (result.healed) {
        notify(`✅ habit "${flowName}" recovered after ${result.attempts} ${result.attempts === 1 ? "retry" : "retries"}.`);
        return output;
      }
      throw err;
    }
  };
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

  const flows = new FlowStore(join(workspace, "flows"));
  const reflexes = new ReflexStore(join(workspace, "reflexes"));
  const journal = new Journal(join(workspace, "journal", "executions.db"));

  const agent = new Agent({
    brains: mind,
    journal,
    conversation: new ConversationStore(join(workspace, "journal", "conversation.db")),
    memory,
    vibes,
    flows,
    tenantId: "dev",
    innerMe: readFileSync(join(workspace, "INNERME.md"), "utf8"),
  });

  return { agent, vibes, flows, reflexes, journal, memory, workspace, via, mcp };
}

/** Everything the dashboard needs to read — and nothing it could write. */
export function dashboardSources(booted: Booted) {
  return {
    journal: booted.journal,
    flows: booted.flows,
    reflexes: booted.reflexes,
    memories: () => booted.memory.all(),
    mind: { via: booted.via, tools: listNodes().length },
    tenantId: "dev",
  };
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
export function handleCommand(input: string, ctx: Booted, chatId: string): string | null {
  const { vibes, flows, agent } = ctx;
  const [cmd, arg] = input.trim().split(/\s+/, 2);

  if (cmd === "/vibe") {
    if (!arg) return `Current vibe: ${vibes.current(chatId)}. Available: ${vibes.list().join(", ")}`;
    return vibes.set(chatId, arg)
      ? `Vibe set to ${arg}.`
      : `No such vibe "${arg}". Available: ${vibes.list().join(", ")}`;
  }

  if (cmd === "/habits") {
    const promoted = flows.promoted();
    const drafts = flows.drafts();
    if (!promoted.length && !drafts.length) return "No habits yet — I'm still improvising everything.";
    const line = (f: { name: string; runs: number; params: string[] }) =>
      `  ${f.name} (${f.runs} runs${f.params.length ? `, needs ${f.params.join(", ")}` : ""})`;
    return [
      promoted.length ? `Habits I run without thinking:\n${promoted.map(line).join("\n")}` : "",
      drafts.length ? `Waiting on your yes (/promote <name>):\n${drafts.map(line).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  if (cmd === "/promote") {
    if (!arg) return "Which habit? Try /habits to see the drafts.";
    if (!flows.promote(arg)) return `No draft habit called "${arg}".`;
    const added = agent.registerHabits();
    return `Promoted **${arg}**. I'll run it directly from now on${added.length ? ` (available as ${added.join(", ")})` : ""}.`;
  }

  if (cmd === "/reflexes") {
    const all = ctx.reflexes.all();
    if (!all.length) return "No reflexes yet. Add one with /reflex <name> <habit> <cron…>";
    return all
      .map(
        (r) =>
          `  ${r.enabled ? "●" : "○"} ${r.name} → ${r.flow} ${
            r.cron ? `on "${r.cron}"` : `on POST /hooks/${r.webhook}`
          }${r.lastRun ? ` · last ${r.lastStatus} at ${r.lastRun.slice(0, 16).replace("T", " ")}` : ""}`,
      )
      .join("\n");
  }

  if (cmd === "/reflex") {
    const [, name, flow, ...rest] = input.trim().split(/\s+/);
    const when = rest.join(" ");
    if (!name || !flow || !when) {
      return 'Usage: /reflex <name> <habit> <cron or hook:path>\ne.g. /reflex morning daily-report 0 9 * * *\n     /reflex on-order make-invoice hook:order';
    }
    if (!ctx.flows.promoted().some((f) => f.name === flow)) {
      return `"${flow}" isn't a promoted habit yet. /habits to see what's available.`;
    }
    try {
      const webhook = when.startsWith("hook:") ? when.slice(5) : undefined;
      ctx.reflexes.save({
        name, flow, enabled: true, createdAt: new Date().toISOString(),
        ...(webhook ? { webhook } : { cron: when }),
      });
      return webhook
        ? `Reflex **${name}** armed — POST /hooks/${webhook} will run ${flow}.`
        : `Reflex **${name}** armed — I'll run ${flow} on "${when}" without being asked.`;
    } catch (err) {
      return `Couldn't arm that: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  if (cmd === "/unreflex") {
    if (!arg) return "Which reflex? /reflexes to see them.";
    return ctx.reflexes.remove(arg) ? `Reflex **${arg}** removed.` : `No reflex called "${arg}".`;
  }

  if (cmd === "/help") {
    return [
      "Commands:",
      "  /habits              what I've learned to do without thinking",
      "  /promote <name>      bless a draft habit",
      "  /reflexes            standing triggers",
      "  /reflex <name> <habit> <cron|hook:path>   arm one",
      "  /unreflex <name>     disarm one",
      "  /vibe <name>         how I speak",
      "  exit",
    ].join("\n");
  }

  return null;
}
