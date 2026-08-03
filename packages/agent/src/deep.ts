import { createServer, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Item, NodeDef } from "@squidclaw/kernel";

const run = promisify(execFile);

/**
 * The deep mind: instead of our loop deciding one step at a time, the whole
 * task is handed to the Claude Code harness — real planning, multi-step
 * reasoning, self-correction — with our nodes exposed to it as an MCP server.
 *
 * The kernel loses nothing: every tool call comes back through this bridge,
 * where it is journaled as a graph step exactly like the classic loop — so
 * habits still crystallize out of deep runs.
 */

export interface BridgeStep {
  node: string;
  params: Record<string, unknown>;
  output: Item[];
  error?: string;
  startedAt: string;
  finishedAt: string;
}

export interface ToolBridge {
  url: string;
  token: string;
  close: () => Promise<void>;
}

/** MCP tool names allow [a-zA-Z0-9_-]; ours have dots. */
export const toMcpName = (name: string) => name.replaceAll(".", "_");

export function startToolBridge(opts: {
  tools: NodeDef[];
  tenantId: string;
  onStep: (step: BridgeStep) => void;
  onProgress?: (note: string) => void;
}): Promise<ToolBridge> {
  const token = randomBytes(16).toString("hex");
  const byMcpName = new Map(opts.tools.map((t) => [toMcpName(t.name), t]));

  const server: Server = createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (req.headers["x-bridge-token"] !== token) return send(401, { error: "bad token" });

    if (req.method === "GET" && req.url === "/tools") {
      return send(
        200,
        opts.tools.map((t) => ({
          name: toMcpName(t.name),
          description: t.description,
          inputSchema: t.inputSchema,
        })),
      );
    }

    if (req.method === "POST" && req.url === "/call") {
      let raw = "";
      req.on("data", (c: Buffer) => (raw += c));
      req.on("end", () => {
        void (async () => {
          try {
            const { name, args } = JSON.parse(raw) as { name: string; args: Record<string, unknown> };
            const tool = byMcpName.get(name);
            if (!tool) return send(404, { error: `no tool "${name}"` });
            opts.onProgress?.(`running ${tool.name}…`);
            const startedAt = new Date().toISOString();
            try {
              const output = await tool.run(args ?? {}, [], { tenantId: opts.tenantId });
              opts.onStep({
                node: tool.name, params: args ?? {}, output,
                startedAt, finishedAt: new Date().toISOString(),
              });
              send(200, { ok: true, result: output.slice(0, 5).map((i) => i.json) });
            } catch (err) {
              opts.onStep({
                node: tool.name, params: args ?? {}, output: [], error: String(err),
                startedAt, finishedAt: new Date().toISOString(),
              });
              send(200, { ok: false, error: String(err) });
            }
          } catch {
            send(400, { error: "body must be JSON {name, args}" });
          }
        })();
      });
      return;
    }

    send(404, { error: "not found" });
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${port}`,
        token,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/** The CLI reads MCP servers from a config file; write one pointing at our shim. */
export function writeMcpConfig(shimPath: string, bridge: ToolBridge): string {
  const dir = mkdtempSync(join(tmpdir(), "sq-mcp-"));
  const path = join(dir, "mcp.json");
  writeFileSync(
    path,
    JSON.stringify({
      mcpServers: {
        squidclaw: {
          command: process.execPath,
          args: [shimPath],
          env: { SQUIDCLAW_BRIDGE_URL: bridge.url, SQUIDCLAW_BRIDGE_TOKEN: bridge.token },
        },
      },
    }),
    "utf8",
  );
  // The CLI may run sandboxed as another user (TARS-style wrappers do exactly
  // this) — the config must be readable across that boundary. It holds only a
  // loopback URL and a token that dies with this one run.
  chmodSync(dir, 0o755);
  chmodSync(path, 0o644);
  return path;
}

export interface DeepOptions {
  /** Path to mcp-shim.mjs — the stdio process the CLI spawns. */
  shimPath: string;
  /** CLI model alias for deep runs. */
  model?: string;
  timeoutMs?: number;
  /** Injectable for tests. */
  exec?: (args: string[], timeoutMs: number) => Promise<string>;
}

const REPLY_SCHEMA = JSON.stringify({
  type: "object",
  required: ["reply"],
  properties: { reply: { type: "string" } },
});

export async function runClaudeDeep(opts: {
  deep: DeepOptions;
  prompt: string;
  system: string;
  mcpConfigPath: string;
}): Promise<string> {
  const exec =
    opts.deep.exec ??
    (async (args: string[], timeoutMs: number) =>
      (await run("claude", args, { timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024 })).stdout);

  const raw = await exec(
    [
      "-p", opts.prompt,
      "--model", opts.deep.model ?? "sonnet",
      "--mcp-config", opts.mcpConfigPath,
      // Strictly our bridge — a tenant's words must never reach the host filesystem.
      // Server-level form: stable across CLI versions (the __* wildcard is not).
      "--allowedTools", "mcp__squidclaw",
      "--append-system-prompt", opts.system,
      "--json-schema", REPLY_SCHEMA,
    ],
    opts.deep.timeoutMs ?? 300_000,
  );

  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("deep run returned nothing readable");
  const parsed = JSON.parse(raw.slice(start, end + 1)) as { reply?: string };
  if (!parsed.reply) throw new Error("deep run returned no reply");
  return cleanReply(parsed.reply);
}

/**
 * Models occasionally leak harness artifacts into their prose —
 * `</reply>`, `</invoke>`, XMLish wrappers. The human never sees plumbing.
 */
export function cleanReply(reply: string): string {
  return reply
    .replace(/<\/?(?:reply|invoke|response|answer|output|antml[\w:-]*)[^>]*>/gi, "")
    .trim();
}
