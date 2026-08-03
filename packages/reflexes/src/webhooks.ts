import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { ReflexStore } from "./store.js";
import type { RunHabit } from "./scheduler.js";

const MAX_BODY = 1_000_000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk: Buffer) => {
      data += chunk;
      if (data.length > MAX_BODY) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

export interface WebhookOptions {
  /** Required in the request as X-Squidclaw-Token when set. */
  token?: string;
  onFire?: (reflex: string, status: "ok" | "error", detail?: string) => void;
}

/**
 * The other way the world reaches in: POST /hooks/<name> fires a habit,
 * with the request body as its arguments.
 */
export class WebhookServer {
  private server?: Server;

  constructor(
    private store: ReflexStore,
    private runHabit: RunHabit,
    private opts: WebhookOptions = {},
  ) {}

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (code: number, body: Record<string, unknown>) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/health") return send(200, { ok: true });

    const match = url.pathname.match(/^\/hooks\/([\w.-]+)$/);
    if (!match) return send(404, { error: "not found" });
    if (req.method !== "POST") return send(405, { error: "use POST" });
    if (this.opts.token && req.headers["x-squidclaw-token"] !== this.opts.token) {
      return send(401, { error: "bad token" });
    }

    const reflex = this.store.enabled().find((r) => r.webhook === match[1] && r.flow);
    if (!reflex) return send(404, { error: `no enabled reflex for hook "${match[1]}"` });

    let args: Record<string, unknown> = { ...(reflex.args ?? {}) };
    try {
      const raw = await readBody(req);
      if (raw.trim()) args = { ...args, ...(JSON.parse(raw) as Record<string, unknown>) };
    } catch {
      return send(400, { error: "body must be JSON" });
    }

    try {
      const result = await this.runHabit(reflex.flow!, args);
      this.store.recordRun(reflex.name, "ok");
      this.opts.onFire?.(reflex.name, "ok");
      send(200, { ok: true, reflex: reflex.name, result });
    } catch (err) {
      this.store.recordRun(reflex.name, "error");
      this.opts.onFire?.(reflex.name, "error", String(err));
      send(500, { ok: false, reflex: reflex.name, error: String(err) });
    }
  }

  listen(port: number, host = "127.0.0.1"): Promise<number> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      });
    });
    return new Promise((resolve) => {
      this.server!.listen(port, host, () => {
        const addr = this.server!.address() as { port: number };
        resolve(addr.port);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.server) return resolve();
      this.server.close(() => resolve());
    });
  }
}
