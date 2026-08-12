import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { layoutRadial } from "./layout.js";
import { dashboardState, executionDetail, executionList, type Sources } from "./api.js";
import type { Flow } from "@squidclaw/agent";
import { PAGE } from "./page.js";
import { resolveAssetPath } from "./assets.js";
import { safeEqual } from "@squidclaw/tenants";

export interface DashboardOptions {
  /** How often to look for new executions to push to open pages. */
  pollMs?: number;
  /**
   * When set, every request needs it — as `?token=` or an `sc_token` cookie.
   * Required the moment this is reachable from anywhere but localhost.
   */
  token?: string;
  /**
   * Multi-tenant mode: sign-in codes become session cookies, and every API
   * answer is scoped to the session's tenant. The default `src` becomes the
   * admin master view (behind `token`); tenants see only their own mind.
   */
  auth?: {
    redeemCode(code: string): string | undefined;
    createSession(tenantId: string): string;
    sessionTenant(sid: string): string | undefined;
    sourcesFor(tenantId: string): Sources | undefined;
  };
  /**
   * Runs a habit for a tenant. Injected because `habitRunner` lives in the
   * server package, which depends on this one — importing it here would invert
   * that. Absent (single-user dev, tests) the run endpoint answers 501.
   */
  run?(tenantId: string | undefined, name: string, args: Record<string, unknown>): Promise<unknown>;
  /**
   * Called after any write, so a warm agent notices flows that changed under
   * it. Habits are registered into a Map when an organism boots
   * (improviser.registerHabits), so without this a flow promoted through the
   * canvas stays invisible to the agent — and unrunnable — until restart. The
   * chat `/promote` command already does this; this is the same courtesy for
   * the HTTP door.
   */
  refresh?(tenantId: string | undefined): Promise<void> | void;
  /**
   * Talks to the tenant's agent — the same door Telegram knocks on, so the web
   * is a face rather than a second brain. Absent, the chat endpoint answers 501.
   */
  chat?(tenantId: string | undefined, text: string, page?: string): Promise<string>;
}

/**
 * Flow names become file names, so anything that could climb out of the
 * workspace is refused outright. `..` and separators can never match.
 */
const SAFE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * Serves the window into the agent's mind — read-only, by design.
 *
 * Live updates come from polling the journal and pushing over SSE: the agent
 * acts unasked, so a page watching it must not need a refresh.
 */
export class DashboardServer {
  private server?: Server;
  private clients = new Set<{ res: ServerResponse; src: Sources; lastSignature: string }>();
  private timer?: NodeJS.Timeout;

  constructor(
    private src: Sources,
    private opts: DashboardOptions = {},
  ) {}

  private send(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  /** Token from the query string on first visit, from the cookie thereafter. */
  private adminAuthorized(req: IncomingMessage, url: URL): boolean {
    if (!this.opts.token) return !this.opts.auth; // open only in single-user dev mode
    const fromQuery = url.searchParams.get("token");
    if (fromQuery && safeEqual(fromQuery, this.opts.token)) return true;
    const cookie = /(?:^|;\s*)sc_token=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    return !!cookie && safeEqual(decodeURIComponent(cookie), this.opts.token);
  }

  /** Whose mind does this request get to see? */
  private resolveSources(req: IncomingMessage, url: URL): { src: Sources; tenantId?: string } | undefined {
    if (this.opts.auth) {
      const sid = /(?:^|;\s*)sc_session=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
      if (sid) {
        const tenantId = this.opts.auth.sessionTenant(decodeURIComponent(sid));
        if (tenantId) {
          const src = this.opts.auth.sourcesFor(tenantId);
          if (src) return { src, tenantId };
        }
      }
    }
    if (this.adminAuthorized(req, url)) return { src: this.src };
    return undefined;
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    // Self-hosted three.js — the brain renders offline, no CDN, no build.
    // Assets carry no data, so they sit outside auth.
    if (path.startsWith("/assets/")) {
      const asset = resolveAssetPath(path);
      if (!asset) return this.send(res, 404, { error: "no such asset" });
      try {
        res.writeHead(200, { "content-type": "text/javascript", "cache-control": "public, max-age=86400" });
        return void res.end(readFileSync(asset));
      } catch {
        return this.send(res, 404, { error: "no such asset" });
      }
    }

    // The door: a one-time code becomes a 30-day session cookie.
    if (path === "/login" && this.opts.auth) {
      const code = url.searchParams.get("code");
      const tenantId = code ? this.opts.auth.redeemCode(code) : undefined;
      if (!tenantId) {
        res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
        return void res.end("That sign-in link has expired or was already used — ask your agent for a fresh one: /canvas");
      }
      const sid = this.opts.auth.createSession(tenantId);
      res.writeHead(302, {
        location: "/",
        "set-cookie": `sc_session=${encodeURIComponent(sid)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86_400}`,
      });
      return void res.end();
    }

    const resolved = this.resolveSources(req, url);
    if (!resolved) {
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" });
      return void res.end(
        this.opts.auth
          ? "This mind is private. Ask your agent for a sign-in link: send /canvas in your chat."
          : "This mind is private. Append ?token=… to look inside.",
      );
    }
    const src = resolved.src;

    if (path === "/" || path === "/index.html") {
      // Remember the admin token so the page's own fetches and SSE stream carry it.
      const fromQuery = url.searchParams.get("token");
      if (this.opts.token && fromQuery) {
        res.setHeader("set-cookie", `sc_token=${encodeURIComponent(fromQuery)}; HttpOnly; SameSite=Strict; Path=/`);
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(PAGE);
    }

    if (path === "/api/state") return this.send(res, 200, dashboardState(src));

    if (path === "/api/executions") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return this.send(res, 200, executionList(src, limit));
    }

    const run = path.match(/^\/api\/executions\/([\w-]+)$/);
    if (run) {
      const found = executionDetail(src, run[1]);
      return found ? this.send(res, 200, found) : this.send(res, 404, { error: "no such execution" });
    }

    // Create: the canvas (or the agent, through it) writes a new habit. New
    // work always lands as a draft — arming it is a separate, deliberate act.
    if (path === "/api/habits" && req.method === "POST") {
      return void this.write(req, res, async (body) => {
        const flow = this.asFlow(body);
        if (typeof flow === "string") return this.send(res, 400, { error: flow });
        if (src.flows.find(flow.name)) {
          return this.send(res, 409, { error: `a habit named "${flow.name}" already exists` });
        }
        src.flows.save(flow, "draft");
        await this.opts.refresh?.(resolved.tenantId);
        this.send(res, 201, { ok: true, name: flow.name, status: "draft" });
      });
    }

    const habit = path.match(/^\/api\/habits\/([\w.-]+)$/);
    if (habit) {
      const name = decodeURIComponent(habit[1]);
      const flow = src.flows.find(name);

      if (req.method === "DELETE") {
        const gone = src.flows.remove(name);
        if (gone) void this.opts.refresh?.(resolved.tenantId);
        return this.send(res, gone ? 200 : 404, gone ? { ok: true, name } : { error: "no such habit" });
      }

      // Edit in place. A promoted habit stays promoted — a human fixing a live
      // flow should not have to re-arm it — but promotion is never granted here.
      if (req.method === "PATCH") {
        if (!flow) return this.send(res, 404, { error: "no such habit" });
        return void this.write(req, res, async (body) => {
          const merged = this.asFlow({ ...flow, ...body, name: flow.name });
          if (typeof merged === "string") return this.send(res, 400, { error: merged });
          src.flows.save(merged, flow.status);
          await this.opts.refresh?.(resolved.tenantId);
          this.send(res, 200, { ok: true, name: flow.name, status: flow.status });
        });
      }

      if (req.method && req.method !== "GET") return this.send(res, 405, { error: "use GET, PATCH or DELETE" });

      if (!flow) return this.send(res, 404, { error: "no such habit" });
      return this.send(res, 200, {
        ...flow,
        layout: layoutRadial(flow.graph),
        nodes: flow.graph.nodes.map((n) => ({ id: n.id, node: n.node, params: n.params })),
      });
    }

    const action = path.match(/^\/api\/habits\/([\w.-]+)\/(run|promote)$/);
    if (action) {
      const name = decodeURIComponent(action[1]);
      if (req.method !== "POST") return this.send(res, 405, { error: "use POST" });
      if (!src.flows.find(name)) return this.send(res, 404, { error: "no such habit" });

      if (action[2] === "promote") {
        const armed = src.flows.promote(name);
        if (!armed) return this.send(res, 409, { error: "no draft to promote" });
        // Refresh before answering, not after: the caller's very next move is
        // usually to run this flow, and a stale agent would refuse it.
        return void Promise.resolve(this.opts.refresh?.(resolved.tenantId))
          .then(() => this.send(res, 200, { ok: true, name, status: "promoted" }))
          .catch((err) => this.send(res, 500, { error: String(err) }));
      }

      if (!this.opts.run) return this.send(res, 501, { error: "this server cannot run habits" });
      return void this.write(req, res, async (body) => {
        try {
          // Cheap belt-and-braces: a flow promoted by some other door (chat,
          // another tab) should still be runnable here without a restart.
          await this.opts.refresh?.(resolved.tenantId);
          const result = await this.opts.run!(resolved.tenantId, name, body as Record<string, unknown>);
          this.send(res, 200, { ok: true, name, result });
        } catch (err) {
          this.send(res, 500, { ok: false, error: String(err instanceof Error ? err.message : err) });
        }
      });
    }

    // The web face. Same agent, same memory, same habits as Telegram — the
    // canvas is another door onto one mind, not a second one.
    if (path === "/api/chat") {
      if (req.method !== "POST") return this.send(res, 405, { error: "use POST" });
      if (!this.opts.chat) return this.send(res, 501, { error: "this server has no agent attached" });
      return void this.write(req, res, async (body) => {
        const text = String(body.text ?? "").trim();
        if (!text) return this.send(res, 400, { error: "say something" });
        try {
          // Where the human is standing, passed as context rather than
          // instruction: "why did this fail?" needs a referent, but their own
          // words stay the request.
          const reply = await this.opts.chat!(resolved.tenantId, text, body.page ? String(body.page) : undefined);
          // "" is the flow-answered-for-itself sentinel the surfaces use. On a
          // request/response channel nothing else is coming, so say so.
          this.send(res, 200, { reply: reply || "(done)" });
        } catch (err) {
          this.send(res, 500, { error: String(err instanceof Error ? err.message : err) });
        }
      });
    }

    if (path === "/api/events") return this.stream(res, src);

    this.send(res, 404, { error: "not found" });
  }

  /** Reads a JSON body, capped, then hands it to the route. */
  private write(
    req: IncomingMessage,
    res: ServerResponse,
    then: (body: Record<string, unknown>) => Promise<void>,
  ): void {
    let raw = "";
    let tooBig = false;
    req.on("data", (chunk: Buffer) => {
      if (tooBig) return;
      raw += chunk;
      if (raw.length > 2_000_000) {
        tooBig = true;
        this.send(res, 413, { error: "body too large" });
      }
    });
    req.on("end", () => {
      if (tooBig) return;
      let body: Record<string, unknown>;
      try {
        body = raw.trim() ? (JSON.parse(raw) as Record<string, unknown>) : {};
      } catch {
        return this.send(res, 400, { error: "body must be JSON" });
      }
      void then(body).catch((err) => this.send(res, 500, { error: String(err) }));
    });
  }

  /** Validates an incoming flow. Returns the flow, or why it was refused. */
  private asFlow(body: Record<string, unknown>): Flow | string {
    const name = String(body.name ?? "").trim();
    if (!name) return "name is required";
    if (!SAFE_NAME.test(name)) return "name may only contain letters, numbers, dash and underscore";

    const graph = body.graph as Flow["graph"] | undefined;
    if (!graph || !Array.isArray(graph.nodes)) return "graph.nodes is required";
    if (!Array.isArray(graph.edges)) return "graph.edges is required";

    return {
      name,
      description: String(body.description ?? ""),
      signature: String(body.signature ?? `ui:${name}`),
      triggers: Array.isArray(body.triggers) ? (body.triggers as string[]) : [],
      params: Array.isArray(body.params) ? (body.params as Flow["params"]) : [],
      graph,
      runs: Number(body.runs ?? 0),
      createdAt: String(body.createdAt ?? new Date().toISOString()),
      status: "draft",
    };
  }

  private stream(res: ServerResponse, src: Sources): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("\n");
    // Each watcher streams only the mind their session unlocked.
    this.clients.add({ res, src, lastSignature: "" });
    res.on("close", () => {
      for (const client of this.clients) if (client.res === res) this.clients.delete(client);
    });
  }

  private push(): void {
    for (const client of this.clients) {
      const executions = executionList(client.src, 50);
      const signature = executions.map((e) => `${e.id}:${e.status}:${e.steps}`).join(",");
      if (signature === client.lastSignature) continue;
      client.lastSignature = signature;
      client.res.write(`data: ${JSON.stringify({ type: "executions", executions })}\n\n`);
    }
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    this.server = createServer((req, res) => {
      try {
        this.handle(req, res);
      } catch (err) {
        this.send(res, 500, { error: String(err) });
      }
    });
    this.timer = setInterval(() => this.push(), this.opts.pollMs ?? 1500);
    this.timer.unref?.();

    return new Promise((resolve) => {
      this.server!.listen(port, host, () => resolve((this.server!.address() as { port: number }).port));
    });
  }

  close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    for (const client of this.clients) client.res.end();
    this.clients.clear();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}
