import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { registerNode, type NodeDef } from "@squidclaw/kernel";

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
}

interface RpcMessage {
  jsonrpc: "2.0";
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

/**
 * A minimal MCP client over stdio.
 *
 * Speaking the protocol directly (rather than pulling in the SDK) keeps the
 * kernel dependency-light and means an MCP tool is just another NodeDef —
 * so borrowed tools crystallize into habits exactly like native ones.
 */
export class McpClient {
  private proc?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private buffer = "";

  constructor(
    readonly serverName: string,
    private config: McpServerConfig,
  ) {}

  async start(timeoutMs = 30_000): Promise<void> {
    this.proc = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...this.config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    this.proc.on("error", (err) => {
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });

    await this.request(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "squidclaw", version: "0.1.0" },
      },
      timeoutMs,
    );
    this.notify("notifications/initialized");
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: RpcMessage;
      try {
        msg = JSON.parse(line) as RpcMessage;
      } catch {
        continue;
      }
      if (typeof msg.id !== "number") continue;
      const waiter = this.pending.get(msg.id);
      if (!waiter) continue;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`${this.serverName}: ${msg.error.message}`));
      else waiter.resolve(msg.result);
    }
  }

  private send(msg: RpcMessage): void {
    if (!this.proc) throw new Error(`MCP server "${this.serverName}" not started`);
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params?: unknown, timeoutMs = 60_000): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${this.serverName}: ${method} timed out`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>> {
    const res = (await this.request("tools/list")) as {
      tools?: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
    };
    return res?.tools ?? [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    return this.request("tools/call", { name, arguments: args });
  }

  stop(): void {
    this.proc?.kill();
  }
}

const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");

/** Turns every tool an MCP server offers into a node this agent can call. */
export async function registerMcpServer(serverName: string, config: McpServerConfig): Promise<NodeDef[]> {
  const client = new McpClient(serverName, config);
  await client.start();
  const tools = await client.listTools();

  const defs: NodeDef[] = tools.map((tool) => ({
    name: `mcp.${sanitize(serverName)}.${sanitize(tool.name)}`,
    description: `[via MCP:${serverName}] ${tool.description ?? tool.name}`,
    inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
    run: async (params) => {
      const result = (await client.callTool(tool.name, params)) as {
        content?: Array<{ type: string; text?: string }>;
        isError?: boolean;
      };
      const text = (result?.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
      if (result?.isError) throw new Error(text || `${serverName}.${tool.name} failed`);
      return [{ json: { server: serverName, tool: tool.name, result: text || result } }];
    },
  }));

  for (const def of defs) registerNode(def);
  return defs;
}

/** Reads a Claude-Code-style mcp.json and wires up every server in it. */
export async function registerMcpServers(config: McpConfig): Promise<{ registered: string[]; failed: Record<string, string> }> {
  const registered: string[] = [];
  const failed: Record<string, string> = {};
  for (const [name, server] of Object.entries(config.mcpServers ?? {})) {
    try {
      const defs = await registerMcpServer(name, server);
      registered.push(...defs.map((d) => d.name));
    } catch (err) {
      failed[name] = String(err);
    }
  }
  return { registered, failed };
}
