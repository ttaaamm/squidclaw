import { describe, it, expect, beforeEach } from "vitest";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { clearNodes, registerNode, Journal } from "@squidclaw/kernel";
import { Agent, startToolBridge, writeMcpConfig, toMcpName, type BridgeStep } from "@squidclaw/agent";

const SHIM = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "server", "src", "mcp-shim.mjs");

const echoTool = {
  name: "web.search",
  description: "searches",
  inputSchema: { type: "object", properties: { query: { type: "string" } } },
  run: async (p: Record<string, unknown>) => [{ json: { hit: `result for ${p.query}` } }],
};

describe("the tool bridge", () => {
  it("lists tools MCP-legally and executes calls, journaling each as a step", async () => {
    const steps: BridgeStep[] = [];
    const bridge = await startToolBridge({ tools: [echoTool], tenantId: "t", onStep: (s) => void steps.push(s) });
    try {
      const headers = { "x-bridge-token": bridge.token, "content-type": "application/json" };

      const tools = (await (await fetch(`${bridge.url}/tools`, { headers })).json()) as Array<{ name: string }>;
      expect(tools[0].name).toBe("web_search"); // dots are illegal in MCP names

      const res = await fetch(`${bridge.url}/call`, {
        method: "POST", headers, body: JSON.stringify({ name: "web_search", args: { query: "squid" } }),
      });
      const body = (await res.json()) as { ok: boolean; result: Array<{ hit: string }> };
      expect(body.ok).toBe(true);
      expect(body.result[0].hit).toBe("result for squid");
      expect(steps[0].node).toBe("web.search"); // journaled under its real name
    } finally {
      await bridge.close();
    }
  });

  it("refuses without the token, and reports tool failures without dying", async () => {
    const boom = { ...echoTool, name: "boom", run: async () => { throw new Error("dead upstream"); } };
    const steps: BridgeStep[] = [];
    const bridge = await startToolBridge({ tools: [boom], tenantId: "t", onStep: (s) => void steps.push(s) });
    try {
      expect((await fetch(`${bridge.url}/tools`)).status).toBe(401);

      const res = await fetch(`${bridge.url}/call`, {
        method: "POST",
        headers: { "x-bridge-token": bridge.token, "content-type": "application/json" },
        body: JSON.stringify({ name: "boom", args: {} }),
      });
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("dead upstream");
      expect(steps[0].error).toContain("dead upstream");
    } finally {
      await bridge.close();
    }
  });

  it("caps a huge tool result before it re-enters the deep mind's context — the journal still gets the whole thing", async () => {
    const bigOutput = { json: { page: "x".repeat(20_000) } };
    const bigTool = { ...echoTool, name: "web.read", run: async () => [bigOutput] };
    const steps: BridgeStep[] = [];
    const bridge = await startToolBridge({ tools: [bigTool], tenantId: "t", onStep: (s) => void steps.push(s) });
    try {
      const res = await fetch(`${bridge.url}/call`, {
        method: "POST",
        headers: { "x-bridge-token": bridge.token, "content-type": "application/json" },
        body: JSON.stringify({ name: "web_read", args: {} }),
      });
      const body = (await res.json()) as { ok: boolean; result: Array<{ truncated?: boolean; note?: string }> };
      expect(body.ok).toBe(true);
      expect(JSON.stringify(body.result).length).toBeLessThan(4_000); // capped, not the full 20k
      expect(body.result[0].truncated).toBe(true);
      expect(body.result[0].note).toContain("trimmed");
      // The journal — what the canvas and habits are built from — keeps the real data.
      expect(steps[0].output[0].json.page).toHaveLength(20_000);
    } finally {
      await bridge.close();
    }
  });

  it("caps a giant error message the same way", async () => {
    const boom = { ...echoTool, name: "boom", run: async () => { throw new Error("x".repeat(10_000)); } };
    const bridge = await startToolBridge({ tools: [boom], tenantId: "t", onStep: () => {} });
    try {
      const res = await fetch(`${bridge.url}/call`, {
        method: "POST",
        headers: { "x-bridge-token": bridge.token, "content-type": "application/json" },
        body: JSON.stringify({ name: "boom", args: {} }),
      });
      const body = (await res.json()) as { error: string };
      expect(body.error.length).toBeLessThan(3_100);
      expect(body.error).toContain("[trimmed]");
    } finally {
      await bridge.close();
    }
  });
});

describe("the MCP shim, as a real process", () => {
  it("speaks MCP over stdio and proxies to the bridge", async () => {
    const bridge = await startToolBridge({ tools: [echoTool], tenantId: "t", onStep: () => {} });
    const shim = spawn(process.execPath, [SHIM], {
      env: { ...process.env, SQUIDCLAW_BRIDGE_URL: bridge.url, SQUIDCLAW_BRIDGE_TOKEN: bridge.token },
      stdio: ["pipe", "pipe", "inherit"],
    });

    const responses: Array<Record<string, unknown>> = [];
    let buffer = "";
    shim.stdout.setEncoding("utf8");
    shim.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (line) responses.push(JSON.parse(line) as Record<string, unknown>);
      }
    });
    const waitFor = async (count: number) => {
      for (let i = 0; i < 100 && responses.length < count; i++) await new Promise((r) => setTimeout(r, 50));
    };
    const ask = (msg: Record<string, unknown>) => shim.stdin.write(`${JSON.stringify(msg)}\n`);

    try {
      ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05" } });
      await waitFor(1);
      expect((responses[0].result as { serverInfo: { name: string } }).serverInfo.name).toBe("squidclaw");

      ask({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      await waitFor(2);
      const tools = (responses[1].result as { tools: Array<{ name: string }> }).tools;
      expect(tools[0].name).toBe("web_search");

      ask({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "web_search", arguments: { query: "octopus" } } });
      await waitFor(3);
      const call = responses[2].result as { content: Array<{ text: string }>; isError: boolean };
      expect(call.isError).toBe(false);
      expect(call.content[0].text).toContain("result for octopus");
    } finally {
      shim.kill();
      await bridge.close();
    }
  }, 20_000);
});

describe("the deep run", () => {
  beforeEach(clearNodes);

  it("hands the task to the harness, journals bridged calls, and replies", async () => {
    registerNode(echoTool);
    const journal = new Journal(":memory:");

    // A fake harness: reads the MCP config the agent wrote, calls the bridge
    // itself (as the real CLI's MCP client would), then answers.
    const agent = new Agent({
      brains: null as never,
      journal,
      tenantId: "t",
      innerMe: "I am Sanad.",
      deep: {
        shimPath: SHIM,
        exec: async (args: string[]) => {
          const configPath = args[args.indexOf("--mcp-config") + 1];
          const config = JSON.parse(readFileSync(configPath, "utf8")) as {
            mcpServers: { squidclaw: { env: { SQUIDCLAW_BRIDGE_URL: string; SQUIDCLAW_BRIDGE_TOKEN: string } } };
          };
          const { SQUIDCLAW_BRIDGE_URL, SQUIDCLAW_BRIDGE_TOKEN } = config.mcpServers.squidclaw.env;
          await fetch(`${SQUIDCLAW_BRIDGE_URL}/call`, {
            method: "POST",
            headers: { "x-bridge-token": SQUIDCLAW_BRIDGE_TOKEN, "content-type": "application/json" },
            body: JSON.stringify({ name: "web_search", args: { query: "from the harness" } }),
          });
          // The system prompt made it in; so did the guardrail on tools.
          expect(args[args.indexOf("--append-system-prompt") + 1]).toContain("I am Sanad.");
          // An allowlist, checked as a set rather than a literal string: the
          // bridge to our own tools, plus the harness's own WebSearch. What
          // matters is that nothing else got in — the harness can otherwise
          // reach Bash and the filesystem, and the deep mind's reach should be
          // exactly what we granted it.
          const allowed = args[args.indexOf("--allowedTools") + 1].split(/\s+/).filter(Boolean).sort();
          expect(allowed).toEqual(["WebSearch", "mcp__squidclaw"]);
          return JSON.stringify({ reply: "Found it via the deep mind." });
        },
      },
    });

    const reply = await agent.handleMessage("find the thing");
    expect(reply).toBe("Found it via the deep mind.");

    // The bridged call is in the journal, in workflow shape — crystallizable.
    const [rec] = journal.list({ tenantId: "t" });
    expect(rec.kind).toBe("improvised");
    expect(rec.status).toBe("ok");
    expect(rec.steps[0].node).toBe("web.search");
    expect(rec.steps[0].params).toEqual({ query: "from the harness" });
    expect(rec.graph.nodes).toHaveLength(1);
  });

  it("falls back to the classic loop when the deep mind is unavailable", async () => {
    registerNode(echoTool);
    let classicCalls = 0;
    const { Brains } = await import("@squidclaw/brains");
    const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => {
      classicCalls++;
      return { content: [{ type: "text", text: "classic answered" }] };
    });

    const agent = new Agent({
      brains,
      journal: new Journal(":memory:"),
      tenantId: "t",
      innerMe: "",
      deep: { shimPath: SHIM, exec: async () => { throw new Error("claude not installed"); } },
    });

    const reply = await agent.handleMessage("hello");
    expect(reply).toBe("classic answered");
    expect(classicCalls).toBeGreaterThan(0);
  });
});

describe("reply hygiene", () => {
  it("strips harness artifacts the model leaks into its prose", async () => {
    const { cleanReply } = await import("@squidclaw/agent");
    expect(cleanReply("Great headlines here.</reply>\n</invoke>")).toBe("Great headlines here.");
    expect(cleanReply("<reply>clean answer</reply>")).toBe("clean answer");
    expect(cleanReply("no tags at all")).toBe("no tags at all");
    // Honest text that merely mentions angle brackets in code stays intact.
    expect(cleanReply("use <b>bold</b> in html")).toBe("use <b>bold</b> in html");
  });
});
