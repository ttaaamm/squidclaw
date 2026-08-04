import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { layoutRadial } from "./layout.js";
import { dashboardState, executionDetail, executionList, type Sources } from "./api.js";
import { PAGE } from "./page.js";
import { safeEqual } from "@squidclaw/tenants";

const requireFrom = createRequire(import.meta.url);
/** The vendored 3D engine, resolved from node_modules at serve time. */
const threeBuild = dirname(requireFrom.resolve("three"));
const ASSETS: Record<string, string> = {
  "/assets/three.js": join(threeBuild, "three.module.min.js"),
  "/assets/three.core.min.js": join(threeBuild, "three.core.min.js"),
  "/assets/orbit.js": join(threeBuild, "..", "examples", "jsm", "controls", "OrbitControls.js"),
};

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
}

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
      const asset = ASSETS[path];
      if (!asset) return this.send(res, 404, { error: "no such asset" });
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "public, max-age=86400" });
      return void res.end(readFileSync(asset));
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

    const habit = path.match(/^\/api\/habits\/([\w.-]+)$/);
    if (habit) {
      const flow = src.flows.find(decodeURIComponent(habit[1]));
      if (!flow) return this.send(res, 404, { error: "no such habit" });
      return this.send(res, 200, {
        ...flow,
        layout: layoutRadial(flow.graph),
        nodes: flow.graph.nodes.map((n) => ({ id: n.id, node: n.node, params: n.params })),
      });
    }

    if (path === "/api/events") return this.stream(res, src);

    this.send(res, 404, { error: "not found" });
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
