import { getNode, listNodes, type Graph, type Item, type Journal, type NodeDef } from "@squidclaw/kernel";
import type { Mind, ToolSpec } from "@squidclaw/brains";
import type { ConversationStore, SemanticMemory } from "@squidclaw/memory";
import type { VibeState } from "./vibes.js";
import { flowNode, type FlowStore } from "./flows.js";
import { crystallize, findRepeatedWork } from "./crystallizer.js";

// Anthropic tool names can't contain dots; node "http.request" <-> tool "http__request".
const toToolName = (nodeName: string) => nodeName.replaceAll(".", "__");
const toNodeName = (toolName: string) => toolName.replaceAll("__", ".");

const MAX_TURNS = 12;
/** Memories are cheap to carry but not free — hand it a digest, let it recall the rest. */
const MEMORY_DIGEST_LIMIT = 20;

export interface AgentOptions {
  brains: Mind;
  journal: Journal;
  tenantId: string;
  innerMe: string;
  conversation?: ConversationStore;
  memory?: SemanticMemory;
  vibes?: VibeState;
  /** Where habits live. Without it the agent improvises forever, like every other agent. */
  flows?: FlowStore;
  /** How many times the same work must succeed before it becomes a habit. */
  crystallizeAfter?: number;
  /**
   * Tools private to this agent — its own memory nodes, for one. The global
   * registry is for capabilities every tenant shares; anything holding a
   * tenant's data must come through here instead.
   */
  extraNodes?: NodeDef[];
}

/**
 * The improviser: thinking, recorded as a graph.
 *
 * Every tool call becomes a GraphNode + StepRecord inside ONE execution of
 * kind "improvised" — identical in shape to a crystallized flow. That is what
 * makes crystallization (Phase 2) nearly free: the habit is already written down.
 */
export class Agent {
  /**
   * Habits live on the agent, not in the global registry.
   *
   * Two tenants share the builtin nodes but must never see each other's
   * skills — and a habit named "daily-report" means something different to
   * each of them.
   */
  private habits = new Map<string, NodeDef>();

  constructor(private opts: AgentOptions) {
    this.registerHabits();
  }

  /** Promoted habits become tools, so the agent can reach for a skill it already has. */
  registerHabits(): string[] {
    const { flows, journal } = this.opts;
    if (!flows) return [];
    const added: string[] = [];
    for (const flow of flows.promoted()) {
      const def = flowNode(flow, journal);
      if (this.habits.has(def.name)) continue;
      this.habits.set(def.name, def);
      added.push(def.name);
    }
    return added;
  }

  /** A habit this agent owns, by bare name or full node name. */
  habit(name: string): NodeDef | undefined {
    return this.habits.get(name.startsWith("flow.") ? name : `flow.${name}`);
  }

  /** Everything it can reach for: shared tools, its private tools, its own skills. */
  private available(): NodeDef[] {
    return [...listNodes(), ...(this.opts.extraNodes ?? []), ...this.habits.values()];
  }

  private resolve(name: string): NodeDef | undefined {
    return (
      this.habits.get(name) ??
      this.opts.extraNodes?.find((n) => n.name === name) ??
      getNode(name)
    );
  }

  /**
   * Looks back at what it just did, and at everything before it. Work done
   * enough times becomes a draft habit — waiting on a human's yes, never
   * self-promoting.
   */
  private formHabit(chatId: string, trigger: string): string | null {
    const { flows, journal, tenantId, conversation } = this.opts;
    if (!flows) return null;

    const minRuns = this.opts.crystallizeAfter ?? 2;
    const candidates = findRepeatedWork(journal, tenantId, { minRuns });
    if (!candidates.length) return null;

    // Recent turns give the habit its trigger phrases — what people actually say to ask for it.
    const said = (conversation?.recent(tenantId, chatId) ?? [])
      .filter((t) => t.role === "user")
      .map((t) => t.content);

    for (const candidate of candidates) {
      if (flows.hasSignature(candidate.signature)) continue;
      const flow = crystallize(candidate, [...new Set([...said.slice(-2), trigger])].filter(Boolean));
      flows.saveDraft(flow);
      return `\n\n💡 I've done this ${flow.runs} times now, so I wrote it down as a habit: **${flow.name}**${
        flow.params.length ? ` (asks for: ${flow.params.join(", ")})` : ""
      }. Say \`/promote ${flow.name}\` and I'll stop thinking it through every time.`;
    }
    return null;
  }

  /** Who it is, how it sounds, and what it knows — assembled fresh each turn. */
  private systemPrompt(chatId: string): string {
    const parts = [this.opts.innerMe];

    if (this.opts.vibes) parts.push(this.opts.vibes.prompt(chatId));

    const known = this.opts.memory?.all() ?? [];
    if (known.length) {
      const digest = known
        .slice(0, MEMORY_DIGEST_LIMIT)
        .map((m) => `- ${m.name}: ${m.content.replace(/\s+/g, " ").slice(0, 200)}`)
        .join("\n");
      const more =
        known.length > MEMORY_DIGEST_LIMIT ? `\n(+${known.length - MEMORY_DIGEST_LIMIT} more — use memory.recall)` : "";
      parts.push(`## What I remember\n${digest}${more}`);
    }

    return parts.join("\n\n");
  }

  async handleMessage(
    text: string,
    chatId = "default",
    onProgress?: (note: string) => void,
  ): Promise<string> {
    const { brains, journal, tenantId, conversation } = this.opts;
    const tools: ToolSpec[] = this.available().map((n) => ({
      name: toToolName(n.name),
      description: n.description,
      input_schema: n.inputSchema,
    }));

    const graph: Graph = { nodes: [], edges: [] };
    const execId = journal.begin({ tenantId, kind: "improvised", graph });

    // Episodic memory: what was just said, so it never forgets you mid-sentence.
    const history = (conversation?.recent(tenantId, chatId) ?? []).map((t) => ({
      role: t.role,
      content: t.content,
    }));
    const messages: unknown[] = [...history, { role: "user", content: text }];

    let reply = "";
    let seq = 0;
    let prevNodeId: string | null = null;

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        onProgress?.(turn === 0 ? "thinking it through…" : "putting the pieces together…");
        const res = await brains.complete({
          tier: "strong",
          system: this.systemPrompt(chatId),
          messages,
          tools,
        });
        if (res.toolCalls.length === 0) {
          reply = res.text;
          break;
        }
        messages.push({ role: "assistant", content: res.assistantContent });

        const toolResults: unknown[] = [];
        for (const call of res.toolCalls) {
          const nodeName = toNodeName(call.name);
          onProgress?.(`running ${nodeName}…`);
          const def = this.resolve(nodeName);
          const nodeId = `n${++seq}`;
          graph.nodes.push({ id: nodeId, node: nodeName, params: call.input });
          if (prevNodeId) graph.edges.push({ from: prevNodeId, to: nodeId });
          prevNodeId = nodeId;

          const startedAt = new Date().toISOString();
          let output: Item[] = [];
          let error: string | undefined;
          try {
            if (!def) throw new Error(`Unknown node: ${nodeName}`);
            output = await def.run(call.input, [], { tenantId });
          } catch (err) {
            error = String(err);
          }

          journal.recordStep(execId, {
            nodeId, node: nodeName, params: call.input, input: [], output,
            status: error ? "error" : "ok", error,
            startedAt, finishedAt: new Date().toISOString(),
          });

          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            is_error: !!error,
            content: error ?? JSON.stringify(output.slice(0, 5).map((i) => i.json)),
          });
        }
        messages.push({ role: "user", content: toolResults });
      }

      // Out of turns with no answer? Take the tools away and make it conclude —
      // the human deserves its best summary, not an apology about turn limits.
      if (!reply) {
        onProgress?.("wrapping up…");
        const final = await brains.complete({
          tier: "strong",
          system: this.systemPrompt(chatId),
          messages: [
            ...messages,
            {
              role: "user",
              content:
                "Stop — no more tools. Give your best final answer from what you found so far, in plain language.",
            },
          ],
        });
        reply = final.text;
      }

      journal.setGraph(execId, graph);
      journal.finish(execId, "ok");
      reply = reply || "I did the work but couldn't wrap it into an answer — the journal has the details.";
      conversation?.append(tenantId, chatId, "user", text);
      conversation?.append(tenantId, chatId, "assistant", reply);

      // Only work that actually did something is worth remembering how to do.
      if (graph.nodes.length) {
        const formed = this.formHabit(chatId, text);
        if (formed) return reply + formed;
      }
      return reply;
    } catch (err) {
      journal.setGraph(execId, graph);
      journal.finish(execId, "error");
      return `Something went wrong: ${String(err)}`;
    }
  }
}
