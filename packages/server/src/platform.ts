import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { Journal } from "@squidclaw/kernel";
import type { Mind } from "@squidclaw/brains";
import { ConversationStore, SemanticMemory, memoryNodes, taskList, taskNodes } from "@squidclaw/memory";
import {
  Agent, FlowStore, VibeState, loadVibes,
  answerHatching, beginHatching, birthAnnouncement, type HatchState,
} from "@squidclaw/agent";
import { ReflexStore, Scheduler, reminderNodes } from "@squidclaw/reflexes";
import { AgentPool, TenantStore, PLANS, type Tenant } from "@squidclaw/tenants";
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
  private pool: AgentPool<Booted>;
  private schedulers = new Map<string, Scheduler>();
  private organisms = new Map<string, Booted>();
  private admins: Set<string>;

  constructor(private opts: PlatformOptions) {
    mkdirSync(join(opts.root, "platform"), { recursive: true });
    this.tenants = new TenantStore(join(opts.root, "platform", "tenants.db"));
    this.admins = new Set(opts.adminChats ?? []);
    this.pool = new AgentPool(this.tenants, join(opts.root, "tenants"), (ws, tenant) =>
      this.buildOrganism(ws.dir, tenant),
    );
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
      // Tools holding this tenant's data are private to this agent, never global:
      // its memories, its human's todo list, its own reminders.
      extraNodes: [...memoryNodes(memory), ...taskNodes(taskList(dir)), ...reminderNodes(reflexes)],
    });

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

  async handle(
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

    const reply = await organism.agent.handleMessage(text, chatId, progress);
    this.tenants.record(tenant.id, "thought");
    return reply;
  }

  /**
   * The public webhook door, tenant-aware: POST /hooks/<path> finds whichever
   * warm tenant armed that path. First match wins — collisions are logged.
   */
  hooksServer(token?: string): Server {
    return createServer((req, res) => {
      const send = (code: number, body: Record<string, unknown>) => {
        res.writeHead(code, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };
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
