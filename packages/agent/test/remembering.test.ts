import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, Journal } from "@squidclaw/kernel";
import { ConversationStore, SemanticMemory, registerMemoryNodes } from "@squidclaw/memory";
import { Brains } from "@squidclaw/brains";
import { Agent } from "@squidclaw/agent";

/** Captures what the mind was shown, so we can assert on its context. */
function recordingBrains(responses: unknown[]) {
  const seen: Array<{ system?: string; messages: unknown[] }> = [];
  let i = 0;
  const brains = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
    seen.push({ system: req.system as string, messages: req.messages as unknown[] });
    return responses[i++];
  });
  return { brains, seen };
}

const says = (text: string) => ({ content: [{ type: "text", text }] });

describe("the agent remembers", () => {
  beforeEach(clearNodes);

  it("carries the conversation across separate messages", async () => {
    const conversation = new ConversationStore(":memory:");
    const { brains, seen } = recordingBrains([says("Nice to meet you, Tamer."), says("Your name is Tamer.")]);
    const agent = new Agent({
      brains, journal: new Journal(":memory:"), tenantId: "dev", innerMe: "I am SquidClaw.", conversation,
    });

    await agent.handleMessage("my name is Tamer", "chat1");
    await agent.handleMessage("what is my name?", "chat1");

    // The second call must have been shown the first exchange.
    const second = seen[1].messages as Array<{ role: string; content: string }>;
    expect(second.map((m) => m.content)).toEqual([
      "my name is Tamer", "Nice to meet you, Tamer.", "what is my name?",
    ]);
  });

  it("keeps separate chats from bleeding into each other", async () => {
    const conversation = new ConversationStore(":memory:");
    const { brains, seen } = recordingBrains([says("ok"), says("ok")]);
    const agent = new Agent({
      brains, journal: new Journal(":memory:"), tenantId: "dev", innerMe: "I am SquidClaw.", conversation,
    });

    await agent.handleMessage("chat one secret", "chat1");
    await agent.handleMessage("hello", "chat2");

    const second = seen[1].messages as Array<{ content: string }>;
    expect(second).toHaveLength(1);
    expect(JSON.stringify(second)).not.toContain("secret");
  });

  it("carries what it knows into who it is", async () => {
    const memory = new SemanticMemory(mkdtempSync(join(tmpdir(), "sem-")));
    memory.remember("coffee", "Tamer takes his coffee black.");
    const { brains, seen } = recordingBrains([says("Black, as always.")]);
    const agent = new Agent({
      brains, journal: new Journal(":memory:"), tenantId: "dev", innerMe: "I am SquidClaw.", memory,
    });

    await agent.handleMessage("how do I take my coffee?");

    expect(seen[0].system).toContain("What I remember");
    expect(seen[0].system).toContain("black");
  });

  it("decides for itself what to remember, and it survives", async () => {
    const memory = new SemanticMemory(mkdtempSync(join(tmpdir(), "sem-")));
    registerMemoryNodes(memory);
    const { brains } = recordingBrains([
      {
        content: [
          {
            type: "tool_use", id: "t1", name: "memory__remember",
            input: { name: "deploy rule", content: "Never deploy without Tamer's explicit approval." },
          },
        ],
      },
      says("Noted — I'll always ask first."),
    ]);
    const agent = new Agent({
      brains, journal: new Journal(":memory:"), tenantId: "dev", innerMe: "I am SquidClaw.", memory,
    });

    const reply = await agent.handleMessage("never deploy without asking me first");

    expect(reply).toContain("ask first");
    expect(memory.recall("deploy")[0].content).toContain("explicit approval");
  });
});
