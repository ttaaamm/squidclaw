import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, getNode, listNodes } from "@squidclaw/kernel";
import { registerBuiltinNodes, htmlToText, parseDuckDuckGo, buildPdf, importN8nWorkflow } from "@squidclaw/nodes";

const dir = () => mkdtempSync(join(tmpdir(), "sq-"));

describe("shell + ssh", () => {
  beforeEach(() => {
    clearNodes();
    registerBuiltinNodes();
  });

  it("runs a command and captures stdout", async () => {
    const out = await getNode("shell.exec")!.run({ command: "echo hello-squidclaw" }, [], { tenantId: "t" });
    expect(out[0].json.ok).toBe(true);
    expect(String(out[0].json.stdout)).toContain("hello-squidclaw");
  });

  it("reports failure without throwing, so the agent can react", async () => {
    const out = await getNode("shell.exec")!.run({ command: "exit 3" }, [], { tenantId: "t" });
    expect(out[0].json.ok).toBe(false);
    expect(out[0].json.exitCode).toBe(3);
  });

  it("ssh.exec reports a clean failure for an unreachable host", async () => {
    const out = await getNode("ssh.exec")!.run(
      { host: "no-such-host-squidclaw.invalid", command: "true", timeoutMs: 20000 }, [], { tenantId: "t" },
    );
    expect(out[0].json.ok).toBe(false);
  });
});

describe("web", () => {
  it("strips markup down to readable text", () => {
    const html = `<html><head><style>p{color:red}</style><script>evil()</script></head>
      <body><h1>Title</h1><p>First &amp; best.</p><p>Second.</p></body></html>`;
    const text = htmlToText(html);
    expect(text).toContain("Title");
    expect(text).toContain("First & best.");
    expect(text).not.toContain("evil");
    expect(text).not.toContain("color:red");
  });

  it("parses duckduckgo result blocks", () => {
    const html = `
      <div class="result results_links">
        <a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa">Example A</a>
        <a class="result__snippet">Snippet A</a>
      </div>
      <div class="result results_links">
        <a class="result__a" href="https://example.org/b">Example B</a>
        <a class="result__snippet">Snippet B</a>
      </div>`;
    const hits = parseDuckDuckGo(html);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({ title: "Example A", url: "https://example.com/a", snippet: "Snippet A" });
    expect(hits[1].url).toBe("https://example.org/b");
  });
});

describe("documents", () => {
  beforeEach(() => {
    clearNodes();
    registerBuiltinNodes();
  });

  it("writes a real PDF file", async () => {
    const path = join(dir(), "report.pdf");
    const out = await getNode("pdf.create")!.run(
      { path, title: "Quarterly Report", body: "Revenue rose.\n\nCosts fell." }, [], { tenantId: "t" },
    );
    expect(out[0].json.path).toBe(path);
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.toString("binary")).toContain("Quarterly Report");
    expect(bytes.subarray(-6).toString()).toContain("%%EOF");
  });

  it("paginates long bodies", () => {
    const pdf = buildPdf("Long", Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n"));
    expect(pdf.toString("binary")).toContain("/Count 5");
  });

  it("writes a real PPTX file", async () => {
    const path = join(dir(), "deck.pptx");
    const out = await getNode("pptx.create")!.run(
      {
        path, title: "SquidClaw", subtitle: "A habit-forming agent",
        slides: [
          { title: "The problem", bullets: ["Agents improvise forever", "Workflows never think"] },
          { title: "The fix", bullets: ["Crystallize what works"], notes: "land this one" },
        ],
      }, [], { tenantId: "t" },
    );
    expect(out[0].json.slides).toBe(3);
    // A .pptx is a zip — check the magic bytes.
    expect(readFileSync(path).subarray(0, 2).toString()).toBe("PK");
  });
});

describe("n8n import", () => {
  beforeEach(() => {
    clearNodes();
    registerBuiltinNodes();
  });

  it("preserves shape and wiring as runnable n8n.step dispatchers", () => {
    const { graph, unsupported } = importN8nWorkflow({
      name: "invoice bot",
      nodes: [
        { name: "Start", type: "n8n-nodes-base.manualTrigger" },
        { name: "Fetch", type: "n8n-nodes-base.httpRequest", parameters: { url: "https://api.example.com", method: "POST" } },
        { name: "Telegram", type: "n8n-nodes-base.telegram", parameters: { chatId: "1" } },
      ],
      connections: {
        Start: { main: [[{ node: "Fetch" }]] },
        Fetch: { main: [[{ node: "Telegram" }]] },
      },
    });

    expect(graph.nodes.map((n) => n.node)).toEqual(["n8n.step", "n8n.step", "n8n.step"]);
    expect(graph.nodes[1].params).toMatchObject({
      type: "n8n-nodes-base.httpRequest",
      n8nName: "Fetch",
      parameters: { url: "https://api.example.com", method: "POST" },
    });
    expect(graph.edges).toHaveLength(2);
    expect(unsupported).toEqual([]); // the whole dialect is spoken now
  });

  it("skips disabled nodes", () => {
    const { graph } = importN8nWorkflow({
      nodes: [
        { name: "A", type: "n8n-nodes-base.noOp" },
        { name: "B", type: "n8n-nodes-base.noOp", disabled: true },
      ],
    });
    expect(graph.nodes).toHaveLength(1);
  });

  it("loads a workflow from disk through the node", async () => {
    const path = join(dir(), "wf.json");
    writeFileSync(path, JSON.stringify({ name: "disk flow", nodes: [{ name: "N", type: "n8n-nodes-base.noOp" }] }));
    const out = await getNode("squidflow.import")!.run({ path }, [], { tenantId: "t" });
    expect(out[0].json.name).toBe("disk flow");
    expect(out[0].json.nodes).toBe(1);
  });

  it("fails loudly on an unsupported node rather than silently skipping", async () => {
    await expect(
      getNode("unsupported.node")!.run({ n8nType: "x.y", n8nName: "N" }, [], { tenantId: "t" }),
    ).rejects.toThrow(/Unsupported imported node/);
  });
});

describe("the arsenal is registered", () => {
  it("exposes every builtin to the agent", () => {
    clearNodes();
    registerBuiltinNodes();
    expect(listNodes().map((n) => n.name).sort()).toEqual([
      "audio.transcribe", "browser.snap", "canvas.snap", "doc.read", "echo",
      "email.read", "email.send", "gotenberg.render", "http.request", "n8n.step",
      "pdf.create", "pptx.create", "shell.exec", "squidflow.import", "ssh.exec",
      "telegram.poll", "telegram.send", "unsupported.node", "vision.look",
      "voice.say", "web.read", "web.search",
    ]);
  });
});
