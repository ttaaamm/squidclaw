// The MCP shim: spawned by the Claude CLI, it speaks the Model Context
// Protocol over stdio and proxies every tool to the agent's ephemeral bridge.
// Plain .mjs on purpose — it must run with bare `node`, no build, no tsx.

const BRIDGE = process.env.SQUIDCLAW_BRIDGE_URL;
const TOKEN = process.env.SQUIDCLAW_BRIDGE_TOKEN;

const headers = { "x-bridge-token": TOKEN, "content-type": "application/json" };

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(req) {
  const { id, method, params } = req;
  if (id === undefined) return; // notification — nothing to answer

  try {
    if (method === "initialize") {
      return send({
        jsonrpc: "2.0", id,
        result: {
          protocolVersion: params?.protocolVersion ?? "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "squidclaw", version: "1.0.0" },
        },
      });
    }

    if (method === "tools/list") {
      const res = await fetch(`${BRIDGE}/tools`, { headers });
      const tools = await res.json();
      return send({ jsonrpc: "2.0", id, result: { tools } });
    }

    if (method === "tools/call") {
      const res = await fetch(`${BRIDGE}/call`, {
        method: "POST",
        headers,
        body: JSON.stringify({ name: params.name, args: params.arguments ?? {} }),
      });
      const body = await res.json();
      return send({
        jsonrpc: "2.0", id,
        result: {
          content: [{ type: "text", text: body.ok ? JSON.stringify(body.result) : String(body.error) }],
          isError: !body.ok,
        },
      });
    }

    if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });

    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${method}` } });
  } catch (err) {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(err) } });
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      void handle(JSON.parse(line));
    } catch {
      // not JSON — ignore
    }
  }
});
