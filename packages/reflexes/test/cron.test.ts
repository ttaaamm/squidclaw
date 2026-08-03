import { describe, it, expect } from "vitest";
import { parseCron, cronMatches, nextRun } from "@squidclaw/reflexes";

const at = (iso: string) => new Date(iso);
const hits = (expr: string, iso: string) => cronMatches(parseCron(expr), at(iso));

describe("cron parsing", () => {
  it("accepts every field form", () => {
    expect(() => parseCron("*/15 9-17 1,15 * mon-fri")).not.toThrow();
    expect(parseCron("0 9 * * *").fields[1].has(9)).toBe(true);
    expect([...parseCron("*/20 * * * *").fields[0]]).toEqual([0, 20, 40]);
    expect([...parseCron("0 0 * * mon,wed").fields[4]].sort()).toEqual([1, 3]);
    expect([...parseCron("0 0 1 jan,jul *").fields[3]].sort()).toEqual([1, 7]);
  });

  it("expands aliases", () => {
    expect(parseCron("@daily").fields[1].has(0)).toBe(true);
    expect(parseCron("@weekly").fields[4].has(0)).toBe(true);
  });

  it("treats sunday as both 0 and 7", () => {
    expect(parseCron("0 0 * * 7").fields[4].has(0)).toBe(true);
  });

  it("rejects nonsense loudly, at save time rather than at 3am", () => {
    expect(() => parseCron("0 9 * *")).toThrow(/expected 5 fields/);
    expect(() => parseCron("99 * * * *")).toThrow(/out of range/);
    expect(() => parseCron("0 9 * * funday")).toThrow(/not a valid value/);
    expect(() => parseCron("*/0 * * * *")).toThrow(/bad step/);
  });
});

describe("cron matching", () => {
  it("matches an exact daily time and nothing else", () => {
    expect(hits("30 9 * * *", "2026-08-03T09:30:00")).toBe(true);
    expect(hits("30 9 * * *", "2026-08-03T09:31:00")).toBe(false);
    expect(hits("30 9 * * *", "2026-08-03T10:30:00")).toBe(false);
  });

  it("honours steps and ranges", () => {
    expect(hits("*/15 * * * *", "2026-08-03T10:45:00")).toBe(true);
    expect(hits("*/15 * * * *", "2026-08-03T10:46:00")).toBe(false);
    expect(hits("0 9-17 * * *", "2026-08-03T17:00:00")).toBe(true);
    expect(hits("0 9-17 * * *", "2026-08-03T18:00:00")).toBe(false);
  });

  it("matches weekdays by name", () => {
    // 2026-08-03 is a Monday.
    expect(hits("0 9 * * mon", "2026-08-03T09:00:00")).toBe(true);
    expect(hits("0 9 * * mon", "2026-08-04T09:00:00")).toBe(false);
  });

  it("ORs day-of-month with day-of-week when both are restricted — cron's oldest quirk", () => {
    const expr = "0 0 15 * mon";
    expect(hits(expr, "2026-08-15T00:00:00")).toBe(true); // the 15th, a Saturday
    expect(hits(expr, "2026-08-03T00:00:00")).toBe(true); // a Monday, not the 15th
    expect(hits(expr, "2026-08-04T00:00:00")).toBe(false); // neither
  });
});

describe("next run", () => {
  it("finds the next firing time, never the current minute", () => {
    const next = nextRun(parseCron("0 9 * * *"), at("2026-08-03T09:00:00"))!;
    expect(next.toISOString().slice(0, 16)).toBe(new Date("2026-08-04T09:00:00").toISOString().slice(0, 16));
  });

  it("crosses month boundaries", () => {
    const next = nextRun(parseCron("0 0 1 * *"), at("2026-08-15T12:00:00"))!;
    expect(next.getMonth()).toBe(8); // September
    expect(next.getDate()).toBe(1);
  });

  it("returns null for something that can never happen", () => {
    expect(nextRun(parseCron("0 0 30 2 *"), at("2026-01-01T00:00:00"))).toBeNull();
  });
});
