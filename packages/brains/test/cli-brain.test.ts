import { describe, it, expect } from "vitest";
import { CliBrain, parseDecision, sanitizeExecError } from "@squidclaw/brains";

describe("cli brain (thinks on the human's subscription)", () => {
  it("turns a structured decision into a tool call", async () => {
    const brain = new CliBrain({
      exec: async () => JSON.stringify({ action: "use_tool", tool: "web__search", input: { query: "n8n" } }),
    });
    const res = await brain.complete({ tier: "strong", messages: [{ role: "user", content: "search" }] });
    expect(res.toolCalls).toHaveLength(1);
    expect(res.toolCalls[0].name).toBe("web__search");
    expect(res.toolCalls[0].input).toEqual({ query: "n8n" });
    expect((res.assistantContent[0] as { type: string }).type).toBe("tool_use");
  });

  it("turns a reply decision into text", async () => {
    const brain = new CliBrain({ exec: async () => JSON.stringify({ action: "reply", reply: "All done." }) });
    const res = await brain.complete({ tier: "cheap", messages: [] });
    expect(res.text).toBe("All done.");
    expect(res.toolCalls).toEqual([]);
  });

  it("passes the chosen model and system prompt to the CLI", async () => {
    let captured: string[] = [];
    const brain = new CliBrain({
      models: { cheap: "haiku", strong: "opus" },
      exec: async (args) => {
        captured = args;
        return JSON.stringify({ action: "reply", reply: "ok" });
      },
    });
    await brain.complete({ tier: "strong", system: "I am SquidClaw.", messages: [] });
    expect(captured[captured.indexOf("--model") + 1]).toBe("opus");
    expect(captured[captured.indexOf("--append-system-prompt") + 1]).toBe("I am SquidClaw.");
  });

  it("renders tool results from the transcript so the brain sees what happened", async () => {
    let prompt = "";
    const brain = new CliBrain({
      exec: async (args) => {
        prompt = args[args.indexOf("-p") + 1];
        return JSON.stringify({ action: "reply", reply: "ok" });
      },
    });
    await brain.complete({
      tier: "cheap",
      messages: [
        { role: "user", content: "fetch it" },
        { role: "assistant", content: [{ type: "tool_use", name: "web__read", input: { url: "u" } }] },
        { role: "user", content: [{ type: "tool_result", content: "the page said hello" }] },
      ],
      tools: [{ name: "web__read", description: "read a page", input_schema: { type: "object" } }],
    });
    expect(prompt).toContain("used web__read");
    expect(prompt).toContain("the page said hello");
    expect(prompt).toContain("read a page");
  });
});

describe("decision parsing survives noisy CLI output", () => {
  it("reads clean json", () => {
    expect(parseDecision('{"action":"reply","reply":"hi"}').reply).toBe("hi");
  });

  it("digs the object out of surrounding hook noise", () => {
    const noisy = 'SessionStart hook ran\n{"action":"reply","reply":"hi"}\nSessionEnd hook failed';
    expect(parseDecision(noisy).reply).toBe("hi");
  });

  it("falls back to treating plain prose as a reply", () => {
    const d = parseDecision("just some text");
    expect(d.action).toBe("reply");
    expect(d.reply).toBe("just some text");
  });
});

/**
 * A real incident: the CLI failed, and execFile's own error carried the
 * ENTIRE command line — prompt, tool list, system prompt — in `.message`.
 * That text became the reply, was journaled as conversation history, and
 * fed the next turn, until an outgoing message was too long for Telegram
 * to send at all ("400: message is too long") and the human saw nothing.
 */
describe("a failed CLI invocation", () => {
  it("never leaks the prompt or command line into the error the human can see", () => {
    const secretPrompt = "You have these tools: " + "x".repeat(50_000);
    const err = Object.assign(new Error(`Command failed: claude -p ${secretPrompt}`), {
      code: 1,
      stderr: "claude: command not found",
    });

    const clean = sanitizeExecError(err);
    expect(clean.message).not.toContain("x".repeat(100));
    expect(clean.message).toContain("claude: command not found");
    expect(clean.message).toContain("exit 1");
    expect(clean.message.length).toBeLessThan(700);
  });

  it("caps a huge stderr too, rather than trusting it to be small", () => {
    const clean = sanitizeExecError({ code: 2, stderr: "boom ".repeat(5_000) });
    expect(clean.message.length).toBeLessThan(700);
    expect(clean.message).toContain("[trimmed]");
  });

  it("still says something useful when there is no stderr at all", () => {
    const clean = sanitizeExecError(Object.assign(new Error("timed out"), { signal: "SIGTERM" }));
    expect(clean.message).toContain("SIGTERM");
    expect(clean.message).toContain("timed out");
  });
});
