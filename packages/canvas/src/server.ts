import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { layoutGraph } from "./layout.js";
import { dashboardState, executionDetail, executionList, type Sources } from "./api.js";
import { PAGE } from "./page.js";
import { safeEqual } from "@squidclaw/tenants";

export interface DashboardOptions {
  /** How often to look for new executions to push to open pages. */
  pollMs?: number;
  /**
   * When set, every request needs it — as `?token=` or an `sc_token` cookie.
   * Required the moment this is reachable from anywhere but localhost.
   */
  token?: string;
}

/**
 * Serves the window into the agent's mind — read-only, by design.
 *
 * Live updates come from polling the journal and pushing over SSE: the agent
 * acts unasked, so a page watching it must not need a refresh.
 */
export class DashboardServer {
  private server?: Server;
  private clients = new Set<ServerResponse>();
  private timer?: NodeJS.Timeout;
  private lastSignature = "";

  constructor(
    private src: Sources,
    private opts: DashboardOptions = {},
  ) {}

  private send(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  /** Token from the query string on first visit, from the cookie thereafter. */
  private authorized(req: IncomingMessage, url: URL): boolean {
    if (!this.opts.token) return true;
    const fromQuery = url.searchParams.get("token");
    if (fromQuery && safeEqual(fromQuery, this.opts.token)) return true;
    const cookie = /(?:^|;\s*)sc_token=([^;]+)/.exec(req.headers.cookie ?? "")?.[1];
    return !!cookie && safeEqual(decodeURIComponent(cookie), this.opts.token);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;

    if (!this.authorized(req, url)) {
      res.writeHead(401, { "content-type": "text/plain" });
      return void res.end("This mind is private. Append ?token=… to look inside.");
    }

    if (path === "/" || path === "/index.html") {
      // Remember the token so the page's own fetches and SSE stream carry it.
      const fromQuery = url.searchParams.get("token");
      if (this.opts.token && fromQuery) {
        res.setHeader("set-cookie", `sc_token=${encodeURIComponent(fromQuery)}; HttpOnly; SameSite=Strict; Path=/`);
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return void res.end(PAGE);
    }

    if (path === "/api/state") return this.send(res, 200, dashboardState(this.src));

    if (path === "/api/executions") {
      const limit = Number(url.searchParams.get("limit") ?? 50);
      return this.send(res, 200, executionList(this.src, limit));
    }

    const run = path.match(/^\/api\/executions\/([\w-]+)$/);
    if (run) {
      const found = executionDetail(this.src, run[1]);
      return found ? this.send(res, 200, found) : this.send(res, 404, { error: "no such execution" });
    }

    const habit = path.match(/^\/api\/habits\/([\w.-]+)$/);
    if (habit) {
      const flow = this.src.flows.find(decodeURIComponent(habit[1]));
      if (!flow) return this.send(res, 404, { error: "no such habit" });
      return this.send(res, 200, {
        ...flow,
        layout: layoutGraph(flow.graph),
        nodes: flow.graph.nodes.map((n) => ({ id: n.id, node: n.node, params: n.params })),
      });
    }

    if (path === "/api/events") return this.stream(res);

    this.send(res, 404, { error: "not found" });
  }

  private stream(res: ServerResponse): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    res.write("\n");
    this.clients.add(res);
    res.on("close", () => this.clients.delete(res));
  }

  private push(): void {
    const executions = executionList(this.src, 50);
    const signature = executions.map((e) => `${e.id}:${e.status}:${e.steps}`).join(",");
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    const payload = `data: ${JSON.stringify({ type: "executions", executions })}\n\n`;
    for (const client of this.clients) client.write(payload);
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
    for (const client of this.clients) client.end();
    this.clients.clear();
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}
