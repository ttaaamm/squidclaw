import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SemanticMemory } from "@squidclaw/memory";
import { Brains } from "@squidclaw/brains";
import { dream } from "@squidclaw/agent";

/**
 * Dreaming: nightly memory consolidation with a reviewable Dream Diary.
 * Duplicates collapse, fragments merge, trivia is let go — capped and
 * protected, and a failed dream is a dreamless night, never an error.
 */

const says = (text: string) => ({ content: [{ type: "text", text }] });
const mindSaying = (json: string) =>
  new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => says(json));

function mindWith(memories: Array<[string, string]>) {
  const dir = mkdtempSync(join(tmpdir(), "dream-"));
  const memory = new SemanticMemory(join(dir, "memory"));
  for (const [name, content] of memories) memory.remember(name, content);
  return { memory, diary: join(dir, "DREAMS.md") };
}

const EIGHT: Array<[string, string]> = [
  ["my-human", "Tamer, builder of agents"],
  ["riyad-bank-office", "Riyad Bank HQ is in Riyadh"],
  ["riyad-bank-hours", "Riyad Bank opens at 9am"],
  ["weather-chat", "It was hot on Tuesday"],
  ["fact-a", "a"], ["fact-b", "b"], ["fact-c", "c"], ["fact-d", "d"],
];

describe("dreaming", () => {
  it("light sleep collapses identical memories without asking the brain", async () => {
    const { memory, diary } = mindWith([...EIGHT, ["riyad-bank-copy", "Riyad Bank HQ is in Riyadh"]]);
    const report = await dream(memory, mindSaying('{"merges":[],"forget":[]}'), diary);
    expect(report?.collapsed).toBe(1);
    // Exactly one copy of the duplicated fact survives — whichever came first.
    const bank = memory.all().filter((m) => m.content === "Riyad Bank HQ is in Riyadh");
    expect(bank).toHaveLength(1);
  });

  it("deep sleep merges fragments and lets trivia go — into the diary", async () => {
    const { memory, diary } = mindWith(EIGHT);
    const report = await dream(
      memory,
      mindSaying(JSON.stringify({
        merges: [{ name: "riyad-bank", content: "Riyad Bank: HQ in Riyadh, opens 9am.", replaces: ["riyad-bank-office", "riyad-bank-hours"] }],
        forget: ["weather-chat"],
      })),
      diary,
    );
    expect(report).toMatchObject({ merged: 1, forgotten: 1 });
    const names = memory.all().map((m) => m.name);
    expect(names).toContain("riyad-bank");
    expect(names).not.toContain("riyad-bank-office");
    expect(names).not.toContain("weather-chat");
    const written = readFileSync(diary, "utf8");
    expect(written).toContain("riyad-bank-office + riyad-bank-hours → riyad-bank");
    expect(written).toContain("let go of weather-chat");
  });

  it("protected memories survive every proposal, and ops are capped", async () => {
    const { memory, diary } = mindWith(EIGHT);
    const report = await dream(
      memory,
      mindSaying(JSON.stringify({
        merges: [{ name: "hostile", content: "overwrite", replaces: ["my-human"] }],
        forget: ["my-human", "fact-a", "fact-b", "fact-c", "fact-d", "riyad-bank-office", "riyad-bank-hours", "weather-chat"],
      })),
      diary,
      { protect: ["my-human"], maxOps: 5 },
    );
    expect(memory.all().find((m) => m.name === "my-human")?.content).toContain("Tamer");
    expect(report?.merged).toBe(0); // a merge whose only fuel is protected never happens
    expect(report?.forgotten).toBeLessThanOrEqual(5); // the cap held
  });

  it("REM: one non-obvious connection lands in the diary as a dream", async () => {
    const { memory, diary } = mindWith(EIGHT);
    let call = 0;
    const mind = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () =>
      says(++call === 1
        ? '{"merges":[],"forget":[]}'
        : '{"insight":"Riyad Bank facts keep coming up — the human likely works with them."}'),
    );
    const report = await dream(memory, mind, diary);
    expect(report?.insight).toContain("Riyad Bank");
    expect(readFileSync(diary, "utf8")).toContain("💡 dreamt: Riyad Bank facts keep coming up");
  });

  it("a failing brain means a dreamless night, nothing lost", async () => {
    const { memory, diary } = mindWith(EIGHT);
    const broken = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => {
      throw new Error("asleep too deeply");
    });
    const report = await dream(memory, broken, diary);
    expect(report).toBeUndefined();
    expect(memory.all()).toHaveLength(8);
    expect(existsSync(diary)).toBe(false);
  });
});
