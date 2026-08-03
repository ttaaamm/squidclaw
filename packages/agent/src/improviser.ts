import { getNode, listNodes, type Graph, type Item, type Journal, type NodeDef } from "@squidclaw/kernel";
import type { Mind, ToolSpec } from "@squidclaw/brains";
import type { ConversationStore, SemanticMemory } from "@squidclaw/memory";
import type { VibeState } from "./vibes.js";
import { flowNode, type FlowStore } from "./flows.js";
import { crystallize, findRepeatedWork } from "./crystallizer.js";
import { cleanReply, runClaudeDeep, startToolBridge, writeMcpConfig, type DeepOptions } from "./deep.js";

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
  /** Passively extract durable facts from each exchange (cheap brain). Default on when memory exists. */
  extractFacts?: boolean;
  /** Read pasted links into context automatically. Default on. */
  autoRead?: boolean;
  /**
   * The deep mind: hand whole tasks to the Claude Code harness with our
   * tools as an MCP server — real planning instead of one decision at a
   * time. Falls back to the classic loop if a deep run fails.
   */
  deep?: DeepOptions;
}

const URL_IN_TEXT = /https?:\/\/[^\s<>")]+/;
const AUTO_READ_CHARS = 4_000;
/** A tool result bigger than this gets trimmed — context is for thinking, not dumping. */
const TOOL_RESULT_CHARS = 3_000;

/**
 * The discipline layer — the difference between a demo and a colleague.
 * Identity lives in INNERME.md; this is craft, and it applies to every agent.
 */
const BEHAVIOR = `## Discipline
- Act first: if a tool can answer it, use the tool before speculating. Never invent tool results or pretend to have checked something.
- Answer in the language the human wrote in. Arabic gets Arabic.
- This is chat: short answers win. No walls of text, no bullet-point essays unless asked. One "sorry" is enough.
- Never say "As an AI", "I'd be happy to help", or "Great question!".
- If the request is ambiguous in a way that changes the outcome, ask one short question instead of guessing.
- When a tool fails, say what you tried and what broke — in plain words, then suggest the next move.
- Numbers, dates, names: verify with a tool when you can; say "I'm not certain" when you can't.`;

const EXTRACT_SCHEMA_HINT =
  'Reply ONLY with JSON: {"facts":[{"name":"short-slug","content":"the fact"}]} — durable facts about the human ' +
  "(preferences, names, rules, relationships, plans). Not small talk, not what they asked this once. " +
  'If nothing is worth keeping: {"facts":[]}';

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
   * The passive ear: after answering, a cheap-brain pass quietly extracts
   * durable facts from the exchange. This is what makes an agent feel like it
   * knows you — remembering things you never told it to remember.
   * Fire-and-forget; a failed extraction must never break a conversation.
   */
  private extractFacts(userText: string, reply: string): void {
    const { memory, brains } = this.opts;
    if (!memory || this.opts.extractFacts === false) return;
    void (async () => {
      try {
        const res = await brains.complete({
          tier: "cheap",
          system: EXTRACT_SCHEMA_HINT,
          messages: [{ role: "user", content: `HUMAN: ${userText}\nAGENT: ${reply}` }],
          maxTokens: 400,
        });
        const start = res.text.indexOf("{");
        const end = res.text.lastIndexOf("}");
        if (start === -1 || end <= start) return;
        const parsed = JSON.parse(res.text.slice(start, end + 1)) as {
          facts?: Array<{ name: string; content: string }>;
        };
        for (const fact of (parsed.facts ?? []).slice(0, 3)) {
          if (fact?.name && fact?.content) memory.remember(fact.name, fact.content);
        }
      } catch {
        // Silence is correct: passive memory is a bonus, never a failure mode.
      }
    })();
  }

  /**
   * The rolling summary: when a chat outgrows its verbatim window, the older
   * turns fold into a compressed "earlier in this conversation" — so a chat
   * from last month still knows what it was about. Fire-and-forget.
   */
  private updateSummary(chatId: string): void {
    const { conversation, brains, tenantId } = this.opts;
    if (!conversation) return;
    void (async () => {
      try {
        const total = conversation.count(tenantId, chatId);
        const covered = conversation.summary(tenantId, chatId)?.turnsCovered ?? 0;
        const window = 20; // the verbatim window recent() carries
        // Only fold when a full window of unsummarized history has scrolled past.
        if (total - covered <= window * 2) return;

        const toCover = total - window;
        const older = conversation.turnsBetween(tenantId, chatId, covered, toCover);
        if (!older.length) return;
        const previous = conversation.summary(tenantId, chatId)?.summary ?? "";

        const res = await brains.complete({
          tier: "cheap",
          system:
            "Fold the new turns into the running summary of this conversation. Keep names, decisions, open threads. A short paragraph — reply with the summary only.",
          messages: [
            {
              role: "user",
              content: `RUNNING SUMMARY:\n${previous || "(none yet)"}\n\nNEW TURNS:\n${older
                .map((t) => `${t.role}: ${t.content}`)
                .join("\n")}`,
            },
          ],
          maxTokens: 400,
        });
        if (res.text.trim()) conversation.setSummary(tenantId, chatId, res.text.trim(), toCover);
      } catch {
        // A missed summary costs nothing; the verbatim window still works.
      }
    })();
  }

  /**
   * The auto-link reader: a pasted URL gets fetched into context before the
   * brain ever thinks, and the fetch is journaled like any other step.
   */
  private async autoReadLink(
    text: string,
    journalStep: (nodeName: string, params: Record<string, unknown>, output: Item[], error?: string) => void,
  ): Promise<string | null> {
    if (this.opts.autoRead === false) return null;
    const url = text.match(URL_IN_TEXT)?.[0];
    if (!url) return null;
    const reader = this.resolve("web.read");
    if (!reader) return null;
    try {
      const output = await reader.run({ url, maxChars: AUTO_READ_CHARS }, [], { tenantId: this.opts.tenantId });
      journalStep("web.read", { url, auto: true }, output);
      const page = output[0]?.json as { text?: string } | undefined;
      if (!page?.text) return null;
      return `[Content of ${url}]:\n${page.text}`;
    } catch (err) {
      journalStep("web.read", { url, auto: true }, [], String(err));
      return null;
    }
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
  private systemPrompt(chatId: string, surface?: string): string {
    const parts = [this.opts.innerMe, BEHAVIOR];

    // Situational awareness: an agent that doesn't know the date feels broken.
    const now = new Date();
    parts.push(
      `## Now\n${now.toISOString()} (${now.toUTCString().slice(0, 3)})` +
        (surface ? ` — speaking on ${surface}` : ""),
    );

    if (this.opts.vibes) parts.push(this.opts.vibes.prompt(chatId));

    // What this chat was about before the recent window — compressed, not lost.
    const summary = this.opts.conversation?.summary(this.opts.tenantId, chatId);
    if (summary?.summary) parts.push(`## Earlier in this conversation\n${summary.summary}`);

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
    meta?: { surface?: string },
  ): Promise<string> {
    if (this.opts.deep) {
      try {
        return await this.deepRun(text, chatId, onProgress, meta);
      } catch {
        onProgress?.("deep mind unavailable — thinking step by step…");
        // fall through to the classic loop
      }
    }
    return this.classicRun(text, chatId, onProgress, meta);
  }

  /**
   * The deep run: one call to the full harness, tools bridged in, every tool
   * call journaled as a graph step — so habits crystallize out of deep runs
   * exactly as they do from the classic loop.
   */
  private async deepRun(
    text: string,
    chatId: string,
    onProgress?: (note: string) => void,
    meta?: { surface?: string },
  ): Promise<string> {
    const { journal, tenantId, conversation } = this.opts;
    const deep = this.opts.deep!;

    const graph: Graph = { nodes: [], edges: [] };
    const execId = journal.begin({ tenantId, kind: "improvised", graph });
    let seq = 0;
    let prev: string | null = null;

    const bridge = await startToolBridge({
      tools: this.available(),
      tenantId,
      onProgress,
      onStep: (step) => {
        const nodeId = `n${++seq}`;
        graph.nodes.push({ id: nodeId, node: step.node, params: step.params });
        if (prev) graph.edges.push({ from: prev, to: nodeId });
        prev = nodeId;
        journal.recordStep(execId, {
          nodeId, node: step.node, params: step.params, input: [], output: step.output,
          status: step.error ? "error" : "ok", error: step.error,
          startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        });
      },
    });

    try {
      const history = (conversation?.recent(tenantId, chatId) ?? [])
        .map((t) => `${t.role}: ${t.content}`)
        .join("\n");
      const prompt = [
        history ? `Conversation so far:\n${history}\n` : "",
        `The human says: ${text}`,
        "Complete the task — use your tools wherever they help — then give your final reply.",
      ]
        .filter(Boolean)
        .join("\n");

      onProgress?.("thinking it through…");
      const reply = await runClaudeDeep({
        deep,
        prompt,
        system: this.systemPrompt(chatId, meta?.surface),
        mcpConfigPath: writeMcpConfig(deep.shimPath, bridge),
      });

      journal.setGraph(execId, graph);
      journal.finish(execId, "ok");
      conversation?.append(tenantId, chatId, "user", text);
      conversation?.append(tenantId, chatId, "assistant", reply);
      this.extractFacts(text, reply);
      this.updateSummary(chatId);

      if (graph.nodes.length) {
        const formed = this.formHabit(chatId, text);
        if (formed) return reply + formed;
      }
      return reply;
    } catch (err) {
      journal.setGraph(execId, graph);
      journal.finish(execId, "error");
      throw err;
    } finally {
      await bridge.close();
    }
  }

  private async classicRun(
    text: string,
    chatId: string,
    onProgress?: (note: string) => void,
    meta?: { surface?: string },
  ): Promise<string> {
    const { brains, journal, tenantId, conversation } = this.opts;
    const tools: ToolSpec[] = this.available().map((n) => ({
      name: toToolName(n.name),
      description: n.description,
      input_schema: n.inputSchema,
    }));

    const graph: Graph = { nodes: [], edges: [] };
    const execId = journal.begin({ tenantId, kind: "improvised", graph });

    let reply = "";
    let seq = 0;
    let prevNodeId: string | null = null;

    const journalStep = (
      nodeName: string,
      params: Record<string, unknown>,
      output: Item[],
      error?: string,
    ): void => {
      const nodeId = `n${++seq}`;
      graph.nodes.push({ id: nodeId, node: nodeName, params });
      if (prevNodeId) graph.edges.push({ from: prevNodeId, to: nodeId });
      prevNodeId = nodeId;
      journal.recordStep(execId, {
        nodeId, node: nodeName, params, input: [], output,
        status: error ? "error" : "ok", error,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
      });
    };

    // A pasted link is read before thinking starts — context arrives with the question.
    let content = text;
    if (URL_IN_TEXT.test(text)) {
      onProgress?.("reading the link…");
      const pageContext = await this.autoReadLink(text, journalStep);
      if (pageContext) content = `${text}\n\n${pageContext}`;
    }

    // Episodic memory: what was just said, so it never forgets you mid-sentence.
    const history = (conversation?.recent(tenantId, chatId) ?? []).map((t) => ({
      role: t.role,
      content: t.content,
    }));
    const messages: unknown[] = [...history, { role: "user", content }];

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        onProgress?.(turn === 0 ? "thinking it through…" : "putting the pieces together…");
        const res = await brains.complete({
          tier: "strong",
          system: this.systemPrompt(chatId, meta?.surface),
          messages,
          tools,
        });
        if (res.toolCalls.length === 0) {
          reply = cleanReply(res.text);
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

          // Context is for thinking, not dumping — a huge result gets a haircut.
          let resultContent = error ?? JSON.stringify(output.slice(0, 5).map((i) => i.json));
          if (resultContent.length > TOOL_RESULT_CHARS) {
            resultContent = `${resultContent.slice(0, TOOL_RESULT_CHARS)}… [trimmed ${resultContent.length - TOOL_RESULT_CHARS} chars — ask for specifics if needed]`;
          }
          toolResults.push({
            type: "tool_result",
            tool_use_id: call.id,
            is_error: !!error,
            content: resultContent,
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
          system: this.systemPrompt(chatId, meta?.surface),
          messages: [
            ...messages,
            {
              role: "user",
              content:
                "Stop — no more tools. Give your best final answer from what you found so far, in plain language.",
            },
          ],
        });
        reply = cleanReply(final.text);
      }

      journal.setGraph(execId, graph);
      journal.finish(execId, "ok");
      reply = reply || "I did the work but couldn't wrap it into an answer — the journal has the details.";
      conversation?.append(tenantId, chatId, "user", text);
      conversation?.append(tenantId, chatId, "assistant", reply);
      this.extractFacts(text, reply); // fire-and-forget: the passive ear
      this.updateSummary(chatId); // fire-and-forget: the rolling memory of this chat

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
