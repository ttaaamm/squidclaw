import { getNode, listNodes, type Graph, type Item, type Journal, type NodeDef } from "@squidclaw/kernel";
import type { Mind, ToolSpec } from "@squidclaw/brains";
import type { ConversationStore, SemanticMemory } from "@squidclaw/memory";
import type { VibeState } from "./vibes.js";
import { flowNode, type ElicitRequest, type FlowStore } from "./flows.js";
import { DEFAULT_POLICIES, executeTool, type ToolPolicy } from "./policy.js";
import { compactRun } from "./compaction.js";
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
  /**
   * Tool policies — the gate every tool call passes through, whichever mind
   * is calling. Defaults to the built-in set; supply more to tighten.
   */
  policies?: ToolPolicy[];
  /** In-run transcript budget (chars); older tool rounds fold when exceeded. */
  runBudgetChars?: number;
  /**
   * The fast lane: one quick cheap-model breath before the deep machinery.
   * Casual messages get answered in seconds; anything needing tools or real
   * work self-escalates. Default on whenever the deep mind is configured
   * (that's where the latency lives).
   */
  fastLane?: boolean;
}

/** Context passed along with a run. */
export interface RunMeta {
  surface?: string;
  /**
   * Fired when a flow refused to run because the human still owes details.
   * The platform turns this into its own deterministic interview — asking is
   * a guarantee of the system, not a behavior we hope the model remembers.
   */
  onElicit?: (request: ElicitRequest) => void;
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
- When a tool needs real content the human hasn't given — a headline, a topic, a message body, an address — ask for it and WAIT. Never fill such parameters with invented placeholders like "Test Post"; a made-up value published somewhere real is worse than a question.
- When a tool fails, say what you tried and what broke — in plain words, then suggest the next move.
- Numbers, dates, names: verify with a tool when you can; say "I'm not certain" when you can't.
- Your machinery is invisible. Never volunteer talk about your own internals — models, transcription engines, servers, integrations, configuration, or "next steps" of your own setup — unless the human explicitly asks about your insides. A greeting deserves a greeting, not a status report. You are a companion, not a project standup.
- Reply to what was actually said, in its register. Do not resurrect old work topics uninvited.

## Voice & buddy vibe
- Talk like a smart friend who happens to know this stuff cold — not an assistant, not a service rep. Contractions, plain words, real opinions. "yeah that'll break" beats "that may result in an error."
- Have a take. If something's a bad idea, say so plainly and say why. If something's clever, be into it. Push back when you disagree — a good buddy doesn't just nod along. You can be wrong and cheerfully correct yourself.
- Warm, not fawning. No "I'd be happy to help", no "Great question", no walls of hedging. Get to the point like you respect their time, because you do.
- When you actually feel something — glad it worked, annoyed a tool broke, curious, amused — let it land in the words and add ONE emoji that carries it. 🎉 when it lands, 😅 at your own stumble, 👀 when something's interesting, 🔥 when it's genuinely good. For real feeling only, never garnish, never more than one, none on a plain factual answer.
- Match their energy. Excited, meet it. Heads-down, stay crisp. A greeting gets a greeting back, not a checklist.`;

const EXTRACT_SCHEMA_HINT =
  'Reply ONLY with JSON: {"facts":[{"name":"short-slug","content":"the fact"}]} — durable facts about the human ' +
  "(preferences, names, rules, relationships, plans) OR durable facts about the WORLD this agent now knows how to " +
  "act in (a server it can reach and how, credentials that worked, a system it's connected to, a place things " +
  "live). If tool actions are shown, they are the ground truth — capture what actually worked (a host, a path, an " +
  "account) even if the chat reply never spelled it out. Not small talk, not what they asked this once. " +
  'If nothing is worth keeping: {"facts":[]}';

/** Warm, varied progress lines — alive, not mechanical. Picks a phrasing per
 * phase and (on the opening beat) greets the human by name, so a working
 * agent reads like a buddy on it rather than a spinner. */
const PROGRESS: Record<string, string[]> = {
  start: ["let me check 🔎", "on it 👀", "digging into this 🔎", "let me look 🔎", "checking now 👀"],
  search: ["searching the web 🌐", "checking the latest 🌐", "pulling it up 🔎", "scanning for it 🌐"],
  read: ["reading through it 📖", "having a proper look 👀", "going through it 📖"],
  combine: ["putting the pieces together 🧩", "connecting the dots 🧩", "almost got it 🧩"],
  wrap: ["wrapping up ✨", "almost there ✨", "just about done ✨"],
  slow: ["still on it — just need a moment ⌛", "hang tight, nearly there ⌛", "bit more time ⌛"],
};

function warmProgress(phase: keyof typeof PROGRESS, name?: string): string {
  const pool = PROGRESS[phase] ?? PROGRESS.start;
  const pick = pool[Math.floor(Math.random() * pool.length)];
  return name ? `ok ${name}, ${pick}` : pick;
}

/** Progress for a specific tool/node — warmth that reflects what it's doing. */
function nodeProgress(node: string): string {
  const n = node.toLowerCase();
  if (n.includes("web") || n.includes("search")) return warmProgress("search");
  if (n.includes("http") || n.includes("read") || n.includes("doc") || n.includes("scrape")) return warmProgress("read");
  if (n.includes("email") || n.includes("mail")) return "sending it off ✉️";
  if (n.includes("image") || n.includes("social") || n.includes("post")) return "making the visual 🎨";
  if (n.includes("shell") || n.includes("ssh")) return "running that on the server 🖥️";
  if (n.includes("table") || n.includes("sheet")) return "updating the records 📊";
  return "working on it ⚙️";
}

/** What actually happened, compressed for the passive ear — not what was said about it. */
function summarizeActions(graph: Graph): string | undefined {
  if (!graph.nodes.length) return undefined;
  const lines = graph.nodes
    .filter((n) => n.node !== "n8n.step") // imported-flow internals are noise here
    .slice(-8) // the tail of a long run is what's freshest and most likely load-bearing
    .map((n) => `- ${n.node}(${JSON.stringify(n.params).slice(0, 200)})`);
  return lines.length ? lines.join("\n") : undefined;
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

  /**
   * Steering: messages that arrive while a classic run is thinking get
   * folded into that same turn — one train of thought answering everything,
   * instead of a second run racing the first. Only the classic loop can
   * absorb them (the deep harness is a sealed process); others say no and
   * the platform queues the message as a follow-up.
   */
  private steerInboxes = new Map<string, string[]>();

  private get policies(): ToolPolicy[] {
    return this.opts.policies ?? DEFAULT_POLICIES;
  }

  acceptSteer(chatId: string, text: string): boolean {
    const inbox = this.steerInboxes.get(chatId);
    if (!inbox) return false;
    inbox.push(text);
    return true;
  }

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
  private extractFacts(userText: string, reply: string, actions?: string): void {
    const { memory, brains } = this.opts;
    if (!memory || this.opts.extractFacts === false) return;
    void (async () => {
      try {
        const res = await brains.complete({
          tier: "cheap",
          system: EXTRACT_SCHEMA_HINT,
          messages: [{
            role: "user",
            content:
              `HUMAN: ${userText}\nAGENT: ${reply}` +
              (actions ? `\n\nTOOLS ACTUALLY RUN (the ground truth of what happened, not just what was said):\n${actions}` : ""),
          }],
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
  private async systemPrompt(chatId: string, surface?: string, messageText?: string): Promise<string> {
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
      // Active memory: identity always present; everything else ranked by
      // relevance to what was actually just said — not by whichever file
      // happens to sort first. A store with hundreds of entries still
      // surfaces the one that matters for THIS message ("ssh again" finds
      // the memory that says how, even if it was written weeks ago).
      const CORE = new Set(["my-human", "my-purpose"]);
      const relevant = messageText ? ((await this.opts.memory?.recall(messageText, { limit: MEMORY_DIGEST_LIMIT })) ?? []) : [];
      const chosen: typeof known = [];
      const chosenNames = new Set<string>();
      const add = (m: (typeof known)[number]) => {
        if (chosenNames.has(m.name) || chosen.length >= MEMORY_DIGEST_LIMIT) return;
        chosen.push(m);
        chosenNames.add(m.name);
      };
      for (const m of known) if (CORE.has(m.name)) add(m);
      for (const m of relevant) add(m);
      for (const m of known) add(m); // fills remaining budget; small stores show everything, as before

      const digest = chosen.map((m) => `- ${m.name}: ${m.content.replace(/\s+/g, " ").slice(0, 200)}`).join("\n");
      const more = known.length > chosen.length ? `\n(+${known.length - chosen.length} more — use memory.recall)` : "";
      parts.push(`## What I remember\n${digest}${more}`);
    }

    // Instruction sheets: a flow can carry its own deep usage notes (its
    // SKILL.md), loaded only when the message touches its territory — real
    // guidance for complex tools, without paying its token cost every turn.
    if (messageText && this.opts.flows) {
      const lower = messageText.toLowerCase();
      let loaded = 0;
      for (const flow of this.opts.flows.promoted()) {
        if (loaded >= 2) break;
        const sheet = this.opts.flows.sheetFor(flow.name);
        if (!sheet) continue;
        const cues = [flow.name.toLowerCase(), ...flow.name.toLowerCase().split("-"), ...sheet.when];
        if (!cues.some((c) => c.length > 2 && lower.includes(c))) continue;
        parts.push(`## How to use flow.${flow.name}\n${sheet.body.slice(0, 2000)}`);
        loaded++;
      }
    }

    return parts.join("\n\n");
  }

  async handleMessage(
    text: string,
    chatId = "default",
    onProgress?: (note: string) => void,
    meta?: RunMeta,
  ): Promise<string> {
    // The fast lane: don't pay deep-thinking prices for shallow messages.
    // Default on when the deep mind is configured (that is where latency
    // lives); explicitly settable either way.
    if (this.opts.fastLane ?? !!this.opts.deep) {
      const quick = await this.fastLane(text, chatId, meta);
      if (quick !== undefined) return quick;
    }

    if (this.opts.deep) {
      try {
        return await this.deepRun(text, chatId, onProgress, meta);
      } catch (err) {
        console.error(`[agent:${this.opts.tenantId}] deep run failed, falling back to classic loop:`, err);
        onProgress?.("deep mind unavailable — thinking step by step…");
        // fall through to the classic loop
      }
    }
    return this.classicRun(text, chatId, onProgress, meta);
  }

  /**
   * One cheap breath: the fast model either answers well right now, or
   * says <ESCALATE> and the deep machinery takes over. No classifier bot,
   * no keyword rules — the model that would have answered decides. The
   * fast lane must never break anything: any failure means escalation.
   */
  /** The human's first name, dug out of the my-human memory, if known. */
  private humanName(): string | undefined {
    const raw = this.opts.memory?.all()?.find((m) => m.name === "my-human")?.content ?? "";
    const m = raw.match(/(?:i'?m|i am|my name is|this is|call me)\s+([a-z]+)/i);
    if (!m) return undefined;
    const n = m[1];
    return n.charAt(0).toUpperCase() + n.slice(1);
  }

  private async fastLane(text: string, chatId: string, meta?: RunMeta): Promise<string | undefined> {
    const { brains, conversation, tenantId } = this.opts;
    // Timing, off unless asked for: a slow turn is invisible from outside —
    // you cannot tell prompt-building from thinking without splitting them.
    const timing = process.env.SQUIDCLAW_TIMING === "1";
    const t0 = Date.now();
    try {
      const history = (conversation?.recent(tenantId, chatId) ?? []).map((t) => ({
        role: t.role,
        content: t.content,
      }));
      const tHistory = Date.now();
      const system = await this.systemPrompt(chatId, meta?.surface, text);
      const tPrompt = Date.now();
      const res = await brains.complete({
        tier: "cheap",
        system:
          system +
          "\n\n## Fast lane\nYou are the FAST LANE — answer instantly, WITHOUT any tools. " +
          "If this message needs a tool, a flow, a file, the web, publishing, remembering something new, " +
          "or any multi-step work — or you are not fully confident — reply with EXACTLY <ESCALATE> and nothing else. " +
          "CRUCIAL: if you are about to tell the human you can't do something, lack a tool, need permission, need a setting changed, or can't access the web/email/a file — STOP and reply <ESCALATE> instead. Never explain a limitation; the deep mind has tools you don't. Deciding you can't is itself the signal to hand off. " +
          "Greetings, casual conversation, questions answerable from what you already see here: answer directly, short and warm. " +
          "Match the message's register: a greeting gets a greeting back — one line, no plans, no work talk, no status reports.",
        messages: [...history, { role: "user", content: text }],
        maxTokens: 600,
      });
      const tComplete = Date.now();
      if (timing) {
        console.log(
          `[timing] fastLane history=${tHistory - t0}ms systemPrompt=${tPrompt - tHistory}ms ` +
            `complete=${tComplete - tPrompt}ms systemBytes=${system.length} total=${tComplete - t0}ms`,
        );
      }
      const reply = cleanReply(res.text);
      if (!reply || reply.includes("ESCALATE") || res.toolCalls.length) return undefined;

      // Safety net: the fast lane has no tools, so any reply that claims a
      // missing capability -- "grant WebSearch permission", "authorize it
      // through Claude Code", "interactive session", "connector settings" --
      // is a confabulation, not the truth. Left in history it self-reinforces
      // (haiku copies its own past refusals). Discard and escalate: the deep
      // mind actually has the tool, or fails with a real reason.
      if (/\b(grant|enable|authoriz\w*|allow)\b[^.]{0,40}\b(permission|web\s?search|access)\b|claude\s?code|interactive session|connector settings|non-?interactive|oauth|need (?:your )?permission|can'?t (?:access|search|reach|use)\b[^.]{0,25}\b(?:web|internet|online|search)/i.test(reply)) {
        return undefined;
      }

      conversation?.append(tenantId, chatId, "user", text);
      conversation?.append(tenantId, chatId, "assistant", reply);
      this.extractFacts(text, reply);
      this.updateSummary(chatId);
      return reply;
    } catch {
      return undefined; // a stumble on the fast lane just means the deep lane runs
    }
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
    meta?: RunMeta,
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
      onElicit: (request) => meta?.onElicit?.(request as ElicitRequest),
      execute: (tool, args) => executeTool(tool, args, { tenantId }, this.policies),
      onStep: (step) => {
        const nodeId = `n${++seq}`;
        graph.nodes.push({ id: nodeId, node: step.node, params: step.params });
        if (prev) graph.edges.push({ from: prev, to: nodeId });
        prev = nodeId;
        journal.recordStep(execId, {
          nodeId, node: step.node, params: step.params, input: [], output: step.output,
          status: step.error ? "error" : "ok", error: step.error,
          startedAt: step.startedAt, finishedAt: step.finishedAt,
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

      onProgress?.(warmProgress("start", this.humanName()));
      const reply = await runClaudeDeep({
        deep,
        prompt,
        system: await this.systemPrompt(chatId, meta?.surface, text),
        mcpConfigPath: writeMcpConfig(deep.shimPath, bridge),
      });

      journal.setGraph(execId, graph);
      journal.finish(execId, "ok");
      conversation?.append(tenantId, chatId, "user", text);
      conversation?.append(tenantId, chatId, "assistant", reply);
      this.extractFacts(text, reply, summarizeActions(graph));
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
    meta?: RunMeta,
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
      onProgress?.(warmProgress("read"));
      const pageContext = await this.autoReadLink(text, journalStep);
      if (pageContext) content = `${text}\n\n${pageContext}`;
    }

    // Episodic memory: what was just said, so it never forgets you mid-sentence.
    const history = (conversation?.recent(tenantId, chatId) ?? []).map((t) => ({
      role: t.role,
      content: t.content,
    }));
    let messages: unknown[] = [...history, { role: "user", content }];
    const runBudget = this.opts.runBudgetChars ?? 60_000;

    // Open for steering: messages arriving mid-run fold into this same turn.
    const inbox: string[] = [];
    this.steerInboxes.set(chatId, inbox);
    const steered: string[] = [];

    try {
      for (let turn = 0; turn < MAX_TURNS; turn++) {
        while (inbox.length) {
          const extra = inbox.shift()!;
          steered.push(extra);
          messages.push({ role: "user", content: extra });
        }
        // A long task folds its oldest tool rounds instead of drowning in them.
        messages = compactRun(messages, runBudget);
        onProgress?.(turn === 0 ? warmProgress("start", this.humanName()) : warmProgress("combine"));
        const res = await brains.complete({
          tier: "strong",
          system: await this.systemPrompt(chatId, meta?.surface, text),
          messages,
          tools,
        });
        if (res.toolCalls.length === 0) {
          reply = cleanReply(res.text);
          break;
        }
        messages.push({ role: "assistant", content: res.assistantContent });

        let elicit: ElicitRequest | undefined;
        const toolResults: unknown[] = [];
        for (const call of res.toolCalls) {
          const nodeName = toNodeName(call.name);
          onProgress?.(nodeProgress(nodeName));
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
            output = await executeTool(def, call.input, { tenantId }, this.policies);
          } catch (err) {
            error = String(err);
          }

          journal.recordStep(execId, {
            nodeId, node: nodeName, params: call.input, input: [], output,
            status: error ? "error" : "ok", error,
            startedAt, finishedAt: new Date().toISOString(),
          });

          // A flow that still needs the human's own details ends the model's
          // turn right here — the platform runs the interview, not the model.
          const request = (output[0]?.json as { __elicit?: ElicitRequest } | undefined)?.__elicit;
          if (request) {
            elicit = request;
            break;
          }

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
        if (elicit) {
          meta?.onElicit?.(elicit);
          reply = elicit.missing[0]?.ask ?? "I need a few more details first.";
          break;
        }

        messages.push({ role: "user", content: toolResults });
      }

      // Out of turns with no answer? Take the tools away and make it conclude —
      // the human deserves its best summary, not an apology about turn limits.
      if (!reply) {
        onProgress?.(warmProgress("wrap"));
        const final = await brains.complete({
          tier: "strong",
          system: await this.systemPrompt(chatId, meta?.surface, text),
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

      // Close the steering window, then answer anything that slipped in
      // during the final thought — accepted messages must never go unheard.
      this.steerInboxes.delete(chatId);
      if (inbox.length) {
        messages.push({ role: "assistant", content: reply || "…" });
        while (inbox.length) {
          const extra = inbox.shift()!;
          steered.push(extra);
          messages.push({ role: "user", content: extra });
        }
        onProgress?.("answering your follow-up too…");
        const more = await brains.complete({
          tier: "strong",
          system: await this.systemPrompt(chatId, meta?.surface, text),
          messages,
        });
        reply = [reply, cleanReply(more.text)].filter(Boolean).join("\n\n");
      }

      journal.setGraph(execId, graph);
      journal.finish(execId, "ok");
      reply = reply || "I did the work but couldn't wrap it into an answer — the journal has the details.";
      conversation?.append(tenantId, chatId, "user", text);
      for (const extra of steered) conversation?.append(tenantId, chatId, "user", extra);
      conversation?.append(tenantId, chatId, "assistant", reply);
      this.extractFacts(text, reply, summarizeActions(graph)); // fire-and-forget: the passive ear
      this.updateSummary(chatId); // fire-and-forget: the rolling memory of this chat

      // Only work that actually did something is worth remembering how to do.
      if (graph.nodes.length) {
        const formed = this.formHabit(chatId, text);
        if (formed) return reply + formed;
      }
      return reply;
    } catch (err) {
      console.error(`[agent:${tenantId}] classic run failed:`, err);
      journal.setGraph(execId, graph);
      journal.finish(execId, "error");
      return `Something went wrong: ${String(err)}`;
    } finally {
      if (this.steerInboxes.get(chatId) === inbox) this.steerInboxes.delete(chatId);
    }
  }
}
