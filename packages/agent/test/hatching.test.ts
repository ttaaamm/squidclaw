import { describe, it, expect } from "vitest";
import { beginHatching, answerHatching, hatch, mapTone, birthAnnouncement } from "@squidclaw/agent";

describe("the birth ritual", () => {
  it("asks the four questions in order and hatches at the end", () => {
    const { state: s0, question: q0 } = beginHatching();
    expect(q0).toContain("What should my name be");

    const a1 = answerHatching(s0, "Sanad");
    expect(a1.question).toContain("who are you");

    const a2 = answerHatching(a1.state, "Tamer — I run Al Jood and The Saudi Times.");
    expect(a2.question).toContain("purpose");

    const a3 = answerHatching(a2.state, "Handle my invoices and social posts.");
    expect(a3.question).toContain("how should I speak");

    const a4 = answerHatching(a3.state, "funny");
    expect(a4.result).toBeDefined();

    const born = a4.result!;
    expect(born.name).toBe("Sanad");
    expect(born.human).toContain("Tamer");
    expect(born.tone).toBe("funny");
    expect(born.innerMe).toContain("I am Sanad");
    expect(born.innerMe).toContain("Al Jood");
    expect(born.innerMe).toContain("invoices");
    // The species' core instincts survive any identity.
    expect(born.innerMe).toContain("memory.remember");
    expect(born.innerMe).toContain("What I do twice");
  });

  it("writes its human and purpose as first memories", () => {
    const born = hatch({ name: "Sanad", human: "Tamer", purpose: "invoices", tone: "warm" });
    expect(born.memories.map((m) => m.name).sort()).toEqual(["my-human", "my-purpose"]);
    expect(born.memories[0].content).toContain("who hatched me");
  });

  it("survives being told nothing — defaults, not crashes", () => {
    const born = hatch({});
    expect(born.name).toBe("SquidClaw");
    expect(born.tone).toBe("warm");
    expect(born.innerMe).toContain("habit-forming agent");
  });

  it("hears a vibe name inside a sentence, and keeps free-text descriptions verbatim", () => {
    expect(mapTone("make it funny please").vibe).toBe("funny");
    expect(mapTone("FORMAL").vibe).toBe("formal");
    const custom = mapTone("like a wise old fisherman");
    expect(custom.vibe).toBe("warm");
    expect(custom.custom).toBe("like a wise old fisherman");
  });

  it("strips 'your name is' framing from the name answer", () => {
    const a = answerHatching(beginHatching().state, "your name is Sanad");
    const done = answerHatching(
      answerHatching(answerHatching(a.state, "T").state, "p").state,
      "warm",
    );
    expect(done.result!.name).toBe("Sanad");
  });

  it("announces itself by its new name and purpose", () => {
    const born = hatch({ name: "Sanad", human: "Tamer", purpose: "run my invoices", tone: "warm" });
    const announcement = birthAnnouncement(born);
    expect(announcement).toContain("I'm Sanad");
    expect(announcement).toContain("run my invoices");
  });
});
