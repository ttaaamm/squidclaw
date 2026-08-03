import { getNode, listNodes, type Graph, type Item, type Journal } from "@squidclaw/kernel";
import type { Mind, ToolSpec } from "@squidclaw/brains";
import type { ConversationStore, SemanticMemory } from "@squidclaw/memory";
import type { VibeState } from "./vibes.js";

// Anthropic tool names can't contain dots; node "http.request" <-> tool "http__request".
const toToolName = (nodeName: string) => nodeName.replaceAll(".", "__");
const toNodeName = (toolName: string) => toolName.replaceAll("__", ".");

const MAX_TURNS = 8;
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
}

/**
 * The improviser: thinking, recorded as a graph.
 *
 * Every tool call becomes a GraphNode + StepRecord inside ONE execution of
 * kind "improvised" — identical in shape to a crystallized flow. That is what
 * makes crystallization (Phase 2) nearly free: the habit is already written down.
 */
export class Agent {
  constructor(private opts: AgentOptions) {}

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

  async handleMessage(text: string, chatId = "default"): Promise<string> {
    const { brains, journal, tenantId, conversation } = this.opts;
    const tools: ToolSpec[] = listNodes().map((n) => ({
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
          const def = getNode(nodeName);
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

      journal.setGraph(execId, graph);
      journal.finish(execId, "ok");
      reply = reply || "(I ran out of thinking turns — check the journal.)";
      conversation?.append(tenantId, chatId, "user", text);
      conversation?.append(tenantId, chatId, "assistant", reply);
      return reply;
    } catch (err) {
      journal.setGraph(execId, graph);
      journal.finish(execId, "error");
      return `Something went wrong: ${String(err)}`;
    }
  }
}
