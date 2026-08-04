import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { Journal, listNodes } from "@squidclaw/kernel";
import type { Mind } from "@squidclaw/brains";
import {
  ConversationStore, KnowledgeBase, Profiles, SemanticMemory,
  knowledgeNodes, memoryNodes, profileNodes, taskList, taskNodes,
} from "@squidclaw/memory";
import { extractTextFromFile } from "@squidclaw/nodes";
import {
  Agent, DEFAULT_POLICIES, FlowStore, VibeState, delegateNode, loadVibes,
  answerHatching, beginHatching, birthAnnouncement, dream, scopePolicy,
  type ElicitRequest, type HatchState,
} from "@squidclaw/agent";
import { ReflexStore, Scheduler, parseWhen, reminderNodes } from "@squidclaw/reflexes";
import { AgentPool, LoginStore, TenantStore, PLANS, safeEqual, type Tenant } from "@squidclaw/tenants";
import type { Sources } from "@squidclaw/canvas";
import { MARKETPLACE } from "@squidclaw/sdk";
import { habitRunner, handleCommand, type Booted } from "./boot.js";

export interface PlatformOptions {
  /** The shared root; each tenant's body grows under <root>/tenants/<id>. */
  root: string;
  mind: Mind;
  via: "api" | "cli";
  /** Chat ids (per surface as "surface:chatId", or bare) allowed to run /tenant commands. */
  adminChats?: string[];
  /** Where reflex firings and healing reports for a tenant should go. */
  notify?: (tenantId: string, message: string) => void;
  /** The deep mind (MCP-bridged Claude Code harness) for every tenant's agent. */
  deep?: import("@squidclaw/agent").DeepOptions;
  /** Where the canvas lives, for sign-in links: e.g. https://flow.preplix.ai */
  publicUrl?: string;
  /** What the plugin loader found at boot — for /plugins visibility. */
  plugins?: {
    plugins: Array<{ name: string; version?: string; description?: string; nodes: number; surfaces: number }>;
    failed: Record<string, string>;
  };
}

/**
 * One platform, many organisms.
 *
 * Every tenant gets its own body — memories, habits, reflexes, journal — in
 * its own directory. They share only the builtin tools and the mind's plumbing.
 * A conversation reaches its tenant through a binding; a binding is made once,
 * with an invite token, and remembered.
 */
export class Platform {
  readonly tenants: TenantStore;
  readonly logins: LoginStore;
  private pool: AgentPool<Booted>;
  private schedulers = new Map<string, Scheduler>();
  private organisms = new Map<string, Booted>();
  private admins: Set<string>;

  constructor(private opts: PlatformOptions) {
    mkdirSync(join(opts.root, "platform"), { recursive: true });
    this.tenants = new TenantStore(join(opts.root, "platform", "tenants.db"));
    this.logins = new LoginStore(join(opts.root, "platform", "auth.db"));
    this.admins = new Set(opts.adminChats ?? []);
    this.pool = new AgentPool(this.tenants, join(opts.root, "tenants"), (ws, tenant) =>
      this.buildOrganism(ws.dir, tenant),
    );
  }

  /** A one-time sign-in link into this tenant's canvas. */
  canvasLink(tenantId: string): string {
    const base = this.opts.publicUrl ?? "http://127.0.0.1:4200";
    return `${base}/login?code=${this.logins.mintCode(tenantId)}`;
  }

  /** Read-only view of one tenant's mind, for the canvas. */
  sourcesFor(tenantId: string): Sources | undefined {
    const tenant = this.tenants.find(tenantId);
    if (!tenant || !tenant.enabled) return undefined;
    const dir = this.tenantDir(tenantId);
    if (!existsSync(dir)) return undefined;
    // The warm organism when there is one; a cold read of the same files otherwise.
    const warm = this.organisms.get(tenantId);
    const journal = warm?.journal ?? new Journal(join(dir, "journal", "executions.db"));
    const flows = warm?.flows ?? new FlowStore(join(dir, "flows"));
    const reflexes = warm?.reflexes ?? new ReflexStore(join(dir, "reflexes"));
    const memory = warm?.memory ?? new SemanticMemory(join(dir, "memory"));
    return {
      journal,
      flows,
      reflexes,
      memories: () => memory.all(),
      mind: { via: this.opts.via, tools: listNodes().length + 16 },
      tenantId,
    };
  }

  /**
   * The Preplix handshake: an outside account (Supabase user id) maps to one
   * tenant. First sight creates it; every later call finds the same one.
   */
  linkPartnerAccount(externalId: string, name: string): { tenant: Tenant; invite: string; canvasLink: string } {
    const tenant = this.tenants.findOrCreateByExternal(externalId, name);
    return { tenant, invite: `/join ${tenant.token}`, canvasLink: this.canvasLink(tenant.id) };
  }

  private buildOrganism(dir: string, tenant: Tenant): Booted {
    mkdirSync(dir, { recursive: true });

    // Born with the species' template soul; each tenant's copy is theirs to shape.
    const innerMePath = join(dir, "INNERME.md");
    if (!existsSync(innerMePath)) copyFileSync(join(this.opts.root, "INNERME.md"), innerMePath);

    const vibesPath = join(this.opts.root, "VIBES.yaml");
    const memory = new SemanticMemory(join(dir, "memory"));
    const flows = new FlowStore(join(dir, "flows"));
    const reflexes = new ReflexStore(join(dir, "reflexes"));
    const journal = new Journal(join(dir, "journal", "executions.db"));
    const vibes = new VibeState(loadVibes(existsSync(vibesPath) ? vibesPath : undefined));

    const agent = new Agent({
      brains: this.opts.mind,
      journal,
      conversation: new ConversationStore(join(dir, "journal", "conversation.db")),
      memory,
      vibes,
      flows,
      tenantId: tenant.id,
      innerMe: readFileSync(innerMePath, "utf8"),
      deep: this.opts.deep,
      // Operator scopes: guarded organs (shell, ssh, email, publish) refuse
      // unless this tenant holds the named grant. Founding tenants hold "*".
      policies: [...DEFAULT_POLICIES, scopePolicy(tenant.scopes)],
      // Tools holding this tenant's data are private to this agent, never global:
      // memories, todo list, reminders, knowledge base, who's-who profiles.
      extraNodes: [
        // The 8-brains door: specialists on demand, parallel, journaled.
        delegateNode({ brains: this.opts.mind, journal, tenantId: tenant.id, memory, policies: [...DEFAULT_POLICIES, scopePolicy(tenant.scopes)] }),
        ...memoryNodes(memory),
        ...taskNodes(taskList(dir)),
        ...reminderNodes(reflexes),
        ...knowledgeNodes(new KnowledgeBase(join(dir, "knowledge")), extractTextFromFile()),
        ...profileNodes(new Profiles(join(dir, "profiles"))),
      ],
    });

    // The nightly cycle: old unused memories fade (decay), then the agent
    // sleeps on what remains (dreaming) — duplicates collapse, fragments
    // merge, trivia is let go, and every change lands in DREAMS.md.
    const protect = ["my-human", "my-purpose"];
    const sweep = () => {
      memory.decay({ maxAgeDays: 45, protect });
      void dream(memory, this.opts.mind, join(dir, "DREAMS.md"), { protect });
    };
    sweep();
    const decayTimer = setInterval(sweep, 24 * 3_600_000);
    decayTimer.unref?.();

    const organism: Booted = {
      agent,
      vibes,
      flows,
      reflexes,
      journal,
      memory,
      workspace: dir,
      via: this.opts.via,
      mcp: { registered: [], failed: {} },
    };

    // Its reflexes fire on its own clock, reporting to its own humans —
    // and every habit run counts against its own budget.
    const notify = (m: string) => this.opts.notify?.(tenant.id, m);
    const run = habitRunner(organism, notify);
    const scheduler = new Scheduler(
      reflexes,
      async (flow, args) => {
        const denied = this.tenants.checkQuota(tenant.id, "habit");
        if (denied) throw new Error(denied);
        const out = await run(flow, args);
        this.tenants.record(tenant.id, "habit");
        return out;
      },
      {
        say: (m) => notify(m),
        onFire: (r) => notify(`⏰ reflex "${r.reflex}" fired — ${r.status}${r.detail ? `: ${r.detail}` : ""}`),
      },
    );
    scheduler.start();
    this.schedulers.set(tenant.id, scheduler);
    this.organisms.set(tenant.id, organism);
    return organism;
  }

  /** Boot every enabled tenant now, so reflexes fire without waiting for a chat. */
  async warmAll(): Promise<number> {
    let warmed = 0;
    for (const tenant of this.tenants.all()) {
      if (!tenant.enabled) continue;
      await this.pool.for(tenant.id);
      warmed++;
    }
    return warmed;
  }

  /** Warm organisms only — a cold tenant's hooks wake when the tenant is warmed. */
  warmOrganisms(): Array<{ tenantId: string; organism: Booted }> {
    return [...this.organisms.entries()].map(([tenantId, organism]) => ({ tenantId, organism }));
  }

  /** A tenant's organism, building it if it isn't warm yet. */
  organismFor(tenantId: string): Promise<Booted> {
    return this.pool.for(tenantId);
  }

  private isAdmin(surface: string, chatId: string): boolean {
    return this.admins.has(`${surface}:${chatId}`) || this.admins.has(chatId);
  }

  // --- hatching -------------------------------------------------------------

  private tenantDir(tenantId: string): string {
    return this.pool.workspaceFor(tenantId).dir;
  }

  private hatched(tenantId: string): boolean {
    return existsSync(join(this.tenantDir(tenantId), ".hatched"));
  }

  private hatchStatePath(tenantId: string): string {
    return join(this.tenantDir(tenantId), "HATCHING.json");
  }

  /** Runs the birth ritual for an unhatched tenant. Returns the next thing to say. */
  private hatchStep(tenantId: string, text: string): string {
    const dir = this.tenantDir(tenantId);
    mkdirSync(dir, { recursive: true });
    const statePath = this.hatchStatePath(tenantId);

    if (!existsSync(statePath)) {
      const { state, question } = beginHatching();
      writeFileSync(statePath, JSON.stringify(state), "utf8");
      return question;
    }

    const state = JSON.parse(readFileSync(statePath, "utf8")) as HatchState;
    const next = answerHatching(state, text);

    if (!next.result) {
      writeFileSync(statePath, JSON.stringify(next.state), "utf8");
      return next.question!;
    }

    // Born: identity written by its human's own answers, then the body wakes.
    writeFileSync(join(dir, "INNERME.md"), next.result.innerMe, "utf8");
    const memoryDir = join(dir, "memory");
    mkdirSync(memoryDir, { recursive: true });
    for (const memory of next.result.memories) {
      writeFileSync(join(memoryDir, `${memory.name}.md`), `${memory.content}\n`, "utf8");
    }
    writeFileSync(join(dir, ".hatched"), new Date().toISOString(), "utf8");
    rmSync(statePath, { force: true });
    this.evictOrganism(tenantId); // rebuild with the newborn identity
    return birthAnnouncement(next.result);
  }

  // --- flow sessions ---------------------------------------------------------
  // A promoted imported flow can take over a chat: every message becomes the
  // flow's trigger item — the n8n conversation state machine, running here.

  private sessionsPath(tenantId: string): string {
    return join(this.tenantDir(tenantId), "flow-sessions.json");
  }

  private flowSessions(tenantId: string): Record<string, string> {
    const path = this.sessionsPath(tenantId);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, string>) : {};
  }

  private setFlowSession(tenantId: string, chatId: string, flowName: string | null): void {
    const sessions = this.flowSessions(tenantId);
    if (flowName) sessions[chatId] = flowName;
    else delete sessions[chatId];
    mkdirSync(this.tenantDir(tenantId), { recursive: true });
    writeFileSync(this.sessionsPath(tenantId), JSON.stringify(sessions), "utf8");
  }

  /**
   * The platform's own interview. When a flow refuses to run because the
   * human still owes details, the pending questions live here — per chat,
   * on disk — and the very next messages answer them. Asking is a guarantee
   * of the system, not a behavior we hope the model remembers.
   */
  private elicitationsPath(tenantId: string): string {
    return join(this.tenantDir(tenantId), "elicitations.json");
  }

  private elicitations(tenantId: string): Record<string, ElicitRequest> {
    const path = this.elicitationsPath(tenantId);
    return existsSync(path) ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, ElicitRequest>) : {};
  }

  private setElicitation(tenantId: string, chatId: string, request: ElicitRequest | null): void {
    const pending = this.elicitations(tenantId);
    if (request) pending[chatId] = request;
    else delete pending[chatId];
    mkdirSync(this.tenantDir(tenantId), { recursive: true });
    writeFileSync(this.elicitationsPath(tenantId), JSON.stringify(pending), "utf8");
  }

  private askOf(request: ElicitRequest): string {
    const q = request.missing[0];
    return `📝 ${q.ask}${q.options ? ` (${q.options.join(" / ")})` : ""}`;
  }

  /** One answer in: record it, ask the next question, or run the flow. */
  private async continueElicitation(
    tenantId: string,
    chatId: string,
    request: ElicitRequest,
    answer: string,
    progress?: (note: string) => void,
  ): Promise<string> {
    const current = request.missing[0];
    const value = answer.trim();

    if (current.options && !current.options.some((o) => o.toLowerCase() === value.toLowerCase())) {
      return `${this.askOf(request)}\nAnswer with one of: ${current.options.join(" / ")} — or /cancel.`;
    }

    request.given[current.name] = current.options
      ? current.options.find((o) => o.toLowerCase() === value.toLowerCase())
      : value;
    request.missing.shift();

    if (request.missing.length) {
      this.setElicitation(tenantId, chatId, request);
      return this.askOf(request);
    }

    // Contract satisfied — run the flow, deterministically, right now.
    this.setElicitation(tenantId, chatId, null);
    const organism = await this.organismFor(tenantId);
    const habit = organism.agent.habit(request.flow);
    if (!habit) return `The "${request.flow}" flow has vanished — /habits shows what exists now.`;
    const denied = this.tenants.checkQuota(tenantId, "habit");
    if (denied) return denied;
    progress?.(`making it now — ${request.flow}…`);
    try {
      const out = await habit.run(request.given, [], { tenantId });
      this.tenants.record(tenantId, "habit");
      // If the contract STILL isn't satisfied (a placeholder answer slipped
      // through), ask again rather than looping silently.
      const again = (out[0]?.json as { __elicit?: ElicitRequest } | undefined)?.__elicit;
      if (again) {
        this.setElicitation(tenantId, chatId, again);
        return this.askOf(again);
      }
      return ""; // the flow's own sends are the reply
    } catch (err) {
      return `⚠️ ${String(err instanceof Error ? err.message : err).slice(0, 300)}`;
    }
  }

  /** The message, dressed as the Telegram update an n8n trigger would emit. */
  private seedFor(chatId: string, text: string) {
    const numericChat = Number(chatId);
    return [
      {
        json: {
          update_id: Math.floor(Math.random() * 1e9),
          message: {
            message_id: Math.floor(Math.random() * 1e9),
            chat: { id: Number.isNaN(numericChat) ? chatId : numericChat, type: "private" },
            from: { id: Number.isNaN(numericChat) ? chatId : numericChat, first_name: "user" },
            date: Math.floor(Date.now() / 1000),
            text,
          },
        } as Record<string, unknown>,
      },
    ];
  }

  private async runFlowSession(
    tenantId: string,
    chatId: string,
    flowName: string,
    text: string,
  ): Promise<string> {
    const organism = await this.pool.for(tenantId);
    const flow = organism.flows.promoted().find((f) => f.name === flowName);
    if (!flow) {
      this.setFlowSession(tenantId, chatId, null);
      return `The flow "${flowName}" isn't promoted anymore — session ended.`;
    }
    const denied = this.tenants.checkQuota(tenantId, "habit");
    if (denied) return `⏳ ${denied}`;

    const { executeGraph } = await import("@squidclaw/kernel");
    const rec = await executeGraph(flow.graph, {
      tenantId,
      kind: "flow",
      journal: organism.journal,
      seedItems: this.seedFor(chatId, text),
    });
    this.tenants.record(tenantId, "habit");

    if (rec.status === "error") {
      const failed = rec.steps.find((s) => s.status === "error");
      return `⚠️ The flow hit a wall at ${String(failed?.params?.n8nName ?? failed?.node ?? "?")}: ${String(failed?.error ?? "").slice(0, 200)}\n(/flow off to leave the flow)`;
    }
    // The flow speaks for itself — its own telegram steps already replied.
    return "";
  }

  /** Fully forget a warm organism — pool, scheduler, and the warm map together. */
  private evictOrganism(tenantId: string): void {
    this.schedulers.get(tenantId)?.stop();
    this.schedulers.delete(tenantId);
    this.organisms.delete(tenantId);
    this.pool.evict(tenantId);
  }

  private adminCommand(input: string): string {
    const parts = input.trim().split(/\s+/);
    const sub = parts[1];

    if (input.trim() === "/tenants" || sub === "list" || !sub) {
      const all = this.tenants.all();
      if (!all.length) return "No tenants yet. /tenant new <name> [plan] creates one.";
      return all
        .map(
          (t) =>
            `  ${t.enabled ? "●" : "○"} ${t.id}  ${t.name} · ${t.plan} · ` +
            `${this.tenants.used(t.id, "thought")} thoughts today`,
        )
        .join("\n");
    }

if (sub === "scopes") {
      const id = parts[2];
      const list = parts[3];
      if (!id || !list) return 'Usage: /tenant scopes <id> <csv|*>  — e.g. /tenant scopes ab12cd34 shell,email  (or *)';
      const scopes = list === "*" ? ["*"] : list.split(",").map((x) => x.trim()).filter(Boolean);
      if (!this.tenants.setScopes(id, scopes)) return `No tenant ${id}.`;
      this.evictOrganism(id); // rebuilt with the new policy on next message
      return `Scopes for ${id} are now: ${scopes.join(", ")}`;
    }

    if (sub === "new") {
      const maybePlan = parts.at(-1) ?? "";
      const hasPlan = maybePlan in PLANS && parts.length > 3;
      const name = parts.slice(2, hasPlan ? -1 : undefined).join(" ");
      if (!name) return "Usage: /tenant new <name> [trial|standard|unlimited]";
      const tenant = this.tenants.create(name, (hasPlan ? maybePlan : "trial") as keyof typeof PLANS);
      return (
        `Created **${tenant.name}** (${tenant.id}, ${tenant.plan}).\n` +
        `Their invite — send it to them, they say it to me in their own chat:\n/join ${tenant.token}`
      );
    }

    if (sub === "plan" && parts[2] && parts[3]) {
      if (!(parts[3] in PLANS)) return `Plans: ${Object.keys(PLANS).join(", ")}`;
      if (!this.tenants.setPlan(parts[2], parts[3])) return `No tenant "${parts[2]}".`;
      this.evictOrganism(parts[2]);
      return `${parts[2]} moved to ${parts[3]}.`;
    }

    if ((sub === "off" || sub === "on") && parts[2]) {
      if (!this.tenants.setEnabled(parts[2], sub === "on")) return `No tenant "${parts[2]}".`;
      if (sub === "off") this.evictOrganism(parts[2]);
      return `${parts[2]} is now ${sub === "on" ? "enabled" : "disabled"}.`;
    }

    if (sub === "token" && parts[2]) {
      const tenant = this.tenants.find(parts[2]);
      return tenant ? `/join ${tenant.token}` : `No tenant "${parts[2]}".`;
    }

    return "Usage: /tenants · /tenant new <name> [plan] · /tenant plan <id> <plan> · /tenant on|off <id> · /tenant token <id>";
  }

  /**
   * The session lane. One run per chat at a time — two rapid messages must
   * never race each other into the journal or produce dueling replies.
   *
   * A message that arrives mid-run is first offered to the active run as
   * steering (the classic mind folds it into the same turn and answers both
   * at once); if the run can't take it, the message waits its turn as a
   * follow-up. Escape hatches — /cancel and /flow — jump the queue, because
   * "stop" must never stand in line behind the thing it's stopping.
   */
  private laneTail = new Map<string, Promise<string>>();

  async handle(
    surface: string,
    chatId: string,
    text: string,
    progress?: (note: string) => void,
  ): Promise<string> {
    const trimmed = text.trim();
    const lane = `${surface}:${chatId}`;
    const busy = this.laneTail.has(lane);

    if (busy && (trimmed === "/cancel" || trimmed.startsWith("/flow"))) {
      return this.handleTurn(surface, chatId, text, progress);
    }

    if (busy && !trimmed.startsWith("/")) {
      const tenant = this.tenants.tenantFor(surface, chatId);
      if (tenant) {
        const organism = this.pool.peek(tenant.id);
        if (organism?.agent.acceptSteer(chatId, text)) return ""; // absorbed into the active turn
      }
    }

    const tail = this.laneTail.get(lane) ?? Promise.resolve("");
    const run = tail
      .catch(() => "")
      .then(() => this.handleTurn(surface, chatId, text, progress));
    this.laneTail.set(lane, run);
    try {
      return await run;
    } finally {
      if (this.laneTail.get(lane) === run) this.laneTail.delete(lane);
    }
  }

  private async handleTurn(
    surface: string,
    chatId: string,
    text: string,
    progress?: (note: string) => void,
  ): Promise<string> {
    const trimmed = text.trim();
    const admin = this.isAdmin(surface, chatId);

    if (admin && (trimmed === "/tenants" || trimmed.startsWith("/tenant"))) {
      return this.adminCommand(trimmed);
    }

    if (admin && trimmed === "/doctor") {
      return this.doctor();
    }

    if (admin && trimmed === "/plugins") {
      const info = this.opts.plugins;
      const installed = info?.plugins.length
        ? info.plugins
            .map((p) => `  🔌 ${p.name}${p.version ? ` v${p.version}` : ""} — ${p.nodes} node(s), ${p.surfaces} surface(s)`)
            .join("\n")
        : "  (none installed)";
      const failed = Object.entries(info?.failed ?? {})
        .map(([n, why]) => `  ⚠️ ${n}: ${why}`)
        .join("\n");
      const market = MARKETPLACE
        .filter((m) => !info?.plugins.some((p) => p.name === m.name))
        .map((m) => `  ◦ ${m.name} — ${m.description} (${m.source})`)
        .join("\n");
      return [
        `Installed plugins:\n${installed}`,
        failed ? `Failed to load:\n${failed}` : "",
        market ? `Available (copy into workspace/plugins and restart):\n${market}` : "",
      ].filter(Boolean).join("\n\n");
    }

    if (trimmed.startsWith("/join")) {
      const token = trimmed.split(/\s+/)[1];
      if (!token) return "Paste the whole invite: /join <token>";
      const tenant = this.tenants.byToken(token);
      if (!tenant) return "That invite doesn't match any account — check it with whoever sent it.";
      this.tenants.bind(surface, chatId, tenant.id);
      // A new agent doesn't say welcome — it asks who it is. The birth ritual.
      if (!this.hatched(tenant.id)) {
        return `Welcome — this chat now belongs to **${tenant.name}**.\n\n${this.hatchStep(tenant.id, "")}`;
      }
      await this.pool.for(tenant.id);
      return `Welcome back — this chat now belongs to **${tenant.name}**.`;
    }

    const tenant = this.tenants.tenantFor(surface, chatId);
    if (!tenant) {
      return admin
        ? "This chat isn't bound to a tenant. /tenant new <name> to create one, then /join <token> here or in their chat."
        : "Hi — I'm SquidClaw, an agent that learns your routine work until it runs itself.\nThis chat isn't connected yet: if you have an invite, say /join <token>.";
    }
    if (!tenant.enabled) return "This account is currently disabled.";

    // Mid-ritual messages continue the ritual — nothing else happens until it's born.
    if (!this.hatched(tenant.id)) return this.hatchStep(tenant.id, text);

    const organism = await this.pool.for(tenant.id);

    // Flow sessions: hand this chat to an imported flow, message by message.
    if (trimmed.startsWith("/flow")) {
      const arg = trimmed.split(/\s+/)[1];
      if (!arg) {
        const active = this.flowSessions(tenant.id)[chatId];
        return active
          ? `This chat is inside the "${active}" flow. /flow off to leave.`
          : "Usage: /flow <promoted-flow-name> to hand this chat to a flow · /flow off to leave.";
      }
      if (arg === "off") {
        this.setFlowSession(tenant.id, chatId, null);
        return "Left the flow — you're talking to me again.";
      }
      const organism = await this.pool.for(tenant.id);
      if (!organism.flows.promoted().some((f) => f.name === arg)) {
        return `"${arg}" isn't a promoted flow. /habits shows what's available; /promote <name> blesses a draft.`;
      }
      this.setFlowSession(tenant.id, chatId, arg);
      // Fire the flow once immediately, as n8n would on the trigger message.
      const first = await this.runFlowSession(tenant.id, chatId, arg, text);
      return first || `▶️ This chat now runs the "${arg}" flow — every message goes straight to it. /flow off to leave.`;
    }

    // Inside a session the flow owns the WHOLE conversation — including its
    // slash commands. n8n bots live on them (/post, /setkey, /cancel, /regen),
    // so nothing may be intercepted except the one escape door this platform
    // promised in every message: /flow off.
    const activeFlow = this.flowSessions(tenant.id)[chatId];
    if (activeFlow && !trimmed.startsWith("/flow")) {
      return this.runFlowSession(tenant.id, chatId, activeFlow, text);
    }

    // An interview in progress: the next messages are answers, not prompts.
    const pendingAsk = this.elicitations(tenant.id)[chatId];
    if (pendingAsk) {
      if (trimmed === "/cancel") {
        this.setElicitation(tenant.id, chatId, null);
        return "Cancelled — ask me again anytime.";
      }
      if (!trimmed.startsWith("/")) {
        return this.continueElicitation(tenant.id, chatId, pendingAsk, text, progress);
      }
      this.setElicitation(tenant.id, chatId, null); // a command means they moved on
    }

    // The window into its own mind — a one-time link, minted for this tenant only.
    if (trimmed === "/canvas") {
      return `🧠 Your agent's mind is here — this link signs you in (works once, expires in 10 minutes):\n${this.canvasLink(tenant.id)}`;
    }

    // A plan holds only so many habits — say so at the door, not after the work.
    if (/^\/promote\b/.test(trimmed)) {
      const quotas = this.tenants.quotas(tenant.id);
      if (organism.flows.promoted().length >= quotas.maxHabits) {
        return `The ${tenant.plan} plan holds up to ${quotas.maxHabits} habits — retire one before promoting another.`;
      }
    }

    const command = handleCommand(text, organism, chatId);
    if (command !== null) return command;

    const denied = this.tenants.checkQuota(tenant.id, "thought");
    if (denied) return `⏳ ${denied}`;

    let elicit: ElicitRequest | undefined;
    const reply = await organism.agent.handleMessage(text, chatId, progress, {
      surface,
      onElicit: (request) => (elicit = request),
    });
    this.tenants.record(tenant.id, "thought");

    // A flow asked for the human's own details: the platform owns the
    // interview from here. The canonical question replaces whatever the
    // model said — deterministic wording, deterministic follow-through.
    if (elicit) {
      this.setElicitation(tenant.id, chatId, elicit);
      return `${this.askOf(elicit)}\n(/cancel if you change your mind)`;
    }

    this.noticeCommitment(organism, text, reply);
    return reply;
  }

  /**
   * The physician's round: one message, every vital sign. Env, mind, disk,
   * renderer tunnel, key store, tenants, plugins — each line ✅ or ⚠️ with
   * the fix named. What OpenClaw calls `doctor`, at home in the chat.
   */
  private async doctor(): Promise<string> {
    const lines: string[] = ["🩺 Doctor's report:"];
    const ok = (s: string) => lines.push(`✅ ${s}`);
    const warn = (s: string) => lines.push(`⚠️ ${s}`);

    // Who am I running as? Root is a disease now, not a default.
    try {
      const { userInfo } = await import("node:os");
      const user = userInfo().username;
      if (user === "root") warn("running as root — the squidclaw service user exists for a reason");
      else ok(`running as ${user}`);
    } catch { /* windows dev boxes have no opinion */ }

    for (const name of ["TELEGRAM_BOT_TOKEN", "SQUIDCLAW_ADMIN_CHAT"]) {
      if (process.env[name]) ok(`${name} set`);
      else warn(`${name} missing`);
    }
    if (!process.env.SQUIDCLAW_PUBLIC_URL) warn("SQUIDCLAW_PUBLIC_URL unset — canvas links will point at localhost");

    // The mind, live: a real (tiny) thought with a deadline.
    try {
      const pong = await Promise.race([
        this.opts.mind.complete({ tier: "cheap", messages: [{ role: "user", content: "Reply with exactly: ok" }], maxTokens: 5 }),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timed out after 20s")), 20_000)),
      ]);
      ok(`mind answering via ${this.opts.via} (${pong.text.trim().slice(0, 20) || "…"})`);
    } catch (err) {
      warn(`mind NOT answering via ${this.opts.via}: ${String(err instanceof Error ? err.message : err).slice(0, 120)}`);
    }

    // Disk under the workspace.
    try {
      const { statfsSync } = await import("node:fs");
      const s = statfsSync(this.opts.root);
      const freeGb = (s.bavail * s.bsize) / 1024 ** 3;
      if (freeGb < 2) warn(`disk low: ${freeGb.toFixed(1)} GB free under the workspace`);
      else ok(`disk: ${freeGb.toFixed(1)} GB free`);
    } catch { warn("disk: could not measure"); }

    // The renderer tunnel (Gotenberg) — the formal post dies without it.
    const gotenberg = process.env.GOTENBERG_URL;
    if (gotenberg) {
      try {
        const res = await fetch(`${gotenberg}/health`, { signal: AbortSignal.timeout(8000) });
        if (res.ok) ok("gotenberg tunnel healthy");
        else warn(`gotenberg tunnel answered HTTP ${res.status}`);
      } catch { warn("gotenberg tunnel unreachable — check the squidclaw-gotenberg service"); }
    } else warn("GOTENBERG_URL unset — no renderer");

    // The social key store: names only, never values.
    try {
      const { readFileSync: read } = await import("node:fs");
      const keys = JSON.parse(read(process.env.SQUIDCLAW_SOCIAL_KEYS ?? "/opt/social/keys.json", "utf8")) as Record<string, string>;
      const present = Object.keys(keys).filter((k) => keys[k]);
      if (present.length) ok(`key store: ${present.join(", ")}`);
      else warn("key store exists but is empty");
    } catch { warn("no social key store (fine unless flows need AI keys)"); }

    // Ears: local model first-class; API keys second; deafness named.
    if (process.env.SQUIDCLAW_WHISPER_BIN && process.env.SQUIDCLAW_WHISPER_MODEL) {
      if (existsSync(process.env.SQUIDCLAW_WHISPER_BIN) && existsSync(process.env.SQUIDCLAW_WHISPER_MODEL)) {
        ok("ears: built-in (local whisper)");
      } else warn("ears configured but binary/model missing — rerun scripts/install-ears.sh");
    } else if (process.env.GEMINI_API_KEY || process.env.OPENAI_API_KEY) {
      ok("ears: via API key");
    } else warn("no ears — bash scripts/install-ears.sh grows built-in ones");

    if (process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_ACCOUNT_ID) ok("instagram connected");
    else lines.push("◦ instagram not connected (INSTAGRAM_ACCESS_TOKEN / INSTAGRAM_ACCOUNT_ID)");

    const tenants = this.tenants.all();
    ok(`tenants: ${tenants.length} (${this.organisms.size} warm)`);

    const p = this.opts.plugins;
    if (p) {
      const failedCount = Object.keys(p.failed).length;
      if (failedCount) warn(`plugins: ${p.plugins.length} loaded, ${failedCount} FAILED (/plugins for details)`);
      else ok(`plugins: ${p.plugins.length} loaded`);
    }

    return lines.join("\n");
  }

  /**
   * Inferred commitments, OpenClaw-style: after a real exchange, a hidden
   * cheap-brain pass may notice a natural future check-in — an interview
   * tomorrow, a flight tonight, feeling sick — and arm a one-shot reminder
   * timed to land just after it. Capped per day, so care never becomes
   * nagging. Fire-and-forget: a missed commitment is a shame, never a bug.
   */
  private noticeCommitment(
    organism: { reflexes: { all(): Array<{ name: string; createdAt: string }>; save(r: never): void } },
    userText: string,
    reply: string,
  ): void {
    if (!reply || userText.trim().startsWith("/")) return;
    void (async () => {
      try {
        const today = new Date().toISOString().slice(0, 10);
        const todays = organism.reflexes.all()
          .filter((r) => r.name.startsWith("commit-") && r.createdAt.slice(0, 10) === today);
        if (todays.length >= 3) return;

        const res = await this.opts.mind.complete({
          tier: "cheap",
          system:
            'You notice future check-in opportunities in conversations. Given one exchange, reply ONLY JSON: ' +
            '{"commitment":{"ask":"a short, warm check-in message to send later","when":"+18h"}} or {"commitment":null}. ' +
            'Only when the human mentioned a concrete future event or state worth caring about afterward — an interview, ' +
            'a flight, being sick, a deadline. "when" is relative (+4h, +1d), timed to land shortly AFTER the event. Unsure? null.',
          messages: [{ role: "user", content: `HUMAN: ${userText}\nAGENT: ${reply}` }],
          maxTokens: 250,
        });
        const start = res.text.indexOf("{");
        const end = res.text.lastIndexOf("}");
        if (start === -1 || end <= start) return;
        const parsed = JSON.parse(res.text.slice(start, end + 1)) as {
          commitment?: { ask?: string; when?: string } | null;
        };
        const c = parsed.commitment;
        if (!c?.ask || !c?.when) return;
        organism.reflexes.save({
          name: `commit-${Date.now().toString(36)}`,
          message: `💭 ${c.ask}`,
          at: parseWhen(String(c.when)),
          enabled: true,
          createdAt: new Date().toISOString(),
        } as never);
      } catch {
        // Silence is correct: a commitment is a kindness, not a contract.
      }
    })();
  }

  /**
   * The public webhook door, tenant-aware: POST /hooks/<path> finds whichever
   * warm tenant armed that path. First match wins — collisions are logged.
   *
   * Also carries the partner API (Bearer-guarded, for Preplix on the same
   * box): POST /partner/link {externalId, name} and POST /partner/sso
   * {externalId} — accounts over there become tenants over here.
   */
  hooksServer(token?: string, partnerKey?: string): Server {
    return createServer((req, res) => {
      const send = (code: number, body: Record<string, unknown>) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      // A local Anthropic-shaped socket, backed by whatever mind this
      // platform thinks with — on a subscription CLI, that means imported
      // flows write text with NO API credits. Point an n8n httpRequest at
      // http://127.0.0.1:<hooksPort>/v1/messages and it just works: same
      // request shape in, same {content:[{type:"text",text}]} out.
      // Localhost only — this is a wall socket, not a public utility.
      if (req.url === "/v1/messages" && req.method === "POST") {
        const remote = req.socket.remoteAddress ?? "";
        if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote)) return send(403, { error: "local callers only" });
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c));
        req.on("end", () => {
          void (async () => {
            try {
              const body = JSON.parse(raw || "{}") as {
                system?: string; messages?: unknown[]; max_tokens?: number;
              };
              const result = await this.opts.mind.complete({
                tier: "strong",
                system: body.system,
                messages: body.messages ?? [],
                maxTokens: body.max_tokens ?? 1024,
              });
              send(200, { content: [{ type: "text", text: result.text }] });
            } catch (err) {
              // Anthropic's error shape, so imported flows' own error
              // handling (Parse Text & friends) reads it natively.
              send(200, { error: { type: "api_error", message: String(err instanceof Error ? err.message : err) } });
            }
          })();
        });
        return;
      }

      if ((req.url ?? "").startsWith("/partner/") && req.method === "POST") {
        const bearer = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
        if (!partnerKey || !bearer || !safeEqual(bearer, partnerKey)) return send(401, { error: "bad partner key" });
        let raw = "";
        req.on("data", (c: Buffer) => (raw += c));
        req.on("end", () => {
          try {
            const body = JSON.parse(raw || "{}") as { externalId?: string; name?: string };
            if (!body.externalId) return send(400, { error: "externalId required" });

            if (req.url === "/partner/link") {
              const linked = this.linkPartnerAccount(body.externalId, body.name ?? "Preplix user");
              return send(200, {
                tenantId: linked.tenant.id,
                name: linked.tenant.name,
                plan: linked.tenant.plan,
                invite: linked.invite,
                canvasLink: linked.canvasLink,
              });
            }
            if (req.url === "/partner/sso") {
              const tenant = this.tenants.byExternal(body.externalId);
              if (!tenant || !tenant.enabled) return send(404, { error: "no linked agent for that account" });
              return send(200, { canvasLink: this.canvasLink(tenant.id) });
            }
            send(404, { error: "not found" });
          } catch {
            send(400, { error: "body must be JSON" });
          }
        });
        return;
      }

      const match = (req.url ?? "").match(/^\/hooks\/([\w.-]+)$/);
      if ((req.url ?? "") === "/health") return send(200, { ok: true });
      if (!match) return send(404, { error: "not found" });
      if (req.method !== "POST") return send(405, { error: "use POST" });
      if (token && req.headers["x-squidclaw-token"] !== token) return send(401, { error: "bad token" });

      const owners = this.warmOrganisms().filter(({ organism }) =>
        organism.reflexes.enabled().some((r) => r.webhook === match[1] && r.flow),
      );
      if (!owners.length) return send(404, { error: `no armed reflex for hook "${match[1]}"` });
      if (owners.length > 1) console.warn(`hook "${match[1]}" armed by ${owners.length} tenants — first wins`);

      const { tenantId, organism } = owners[0];
      const reflex = organism.reflexes.enabled().find((r) => r.webhook === match[1] && r.flow)!;

      let raw = "";
      req.on("data", (c: Buffer) => (raw += c));
      req.on("end", () => {
        void (async () => {
          let args: Record<string, unknown> = { ...(reflex.args ?? {}) };
          try {
            if (raw.trim()) args = { ...args, ...(JSON.parse(raw) as Record<string, unknown>) };
          } catch {
            return send(400, { error: "body must be JSON" });
          }
          try {
            const denied = this.tenants.checkQuota(tenantId, "habit");
            if (denied) return send(429, { error: denied });
            const run = habitRunner(organism, (m) => this.opts.notify?.(tenantId, m));
            const result = await run(reflex.flow!, args);
            organism.reflexes.recordRun(reflex.name, "ok");
            this.tenants.record(tenantId, "habit");
            send(200, { ok: true, reflex: reflex.name, result });
          } catch (err) {
            organism.reflexes.recordRun(reflex.name, "error");
            send(500, { ok: false, error: String(err) });
          }
        })();
      });
    });
  }

  stop(): void {
    for (const scheduler of this.schedulers.values()) scheduler.stop();
    this.schedulers.clear();
  }
}
