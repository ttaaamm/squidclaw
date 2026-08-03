import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ReflexStore, Scheduler, parseWhen, reminderNodes } from "@squidclaw/reflexes";

const dir = () => mkdtempSync(join(tmpdir(), "remind-"));

describe("reading a time the way a human says it", () => {
  const now = new Date("2026-08-03T10:00:00");

  it("understands +30m, +2h, +1d", () => {
    expect(parseWhen("+30m", now)).toBe(new Date("2026-08-03T10:30:00").toISOString());
    expect(parseWhen("+2h", now)).toBe(new Date("2026-08-03T12:00:00").toISOString());
    expect(parseWhen("+1d", now)).toBe(new Date("2026-08-04T10:00:00").toISOString());
  });

  it("takes a bare clock time as today — or tomorrow if it already passed", () => {
    expect(parseWhen("17:45", now)).toBe(new Date("2026-08-03T17:45:00").toISOString());
    expect(parseWhen("08:00", now)).toBe(new Date("2026-08-04T08:00:00").toISOString());
  });

  it("refuses nonsense with advice, not a stack trace", () => {
    expect(() => parseWhen("whenever", now)).toThrow(/try "\+30m"/);
  });
});

describe("one-shot reminders", () => {
  let store: ReflexStore;
  beforeEach(() => {
    store = new ReflexStore(dir());
  });

  it("fires once when due, says its message, then disarms forever", async () => {
    store.save({
      name: "call-khalid", message: "Call Khalid about the invoice",
      at: "2026-08-03T17:00:00Z", enabled: true, createdAt: "now",
    });
    const said: string[] = [];
    let now = new Date("2026-08-03T16:59:00Z");
    const scheduler = new Scheduler(store, async () => undefined, {
      say: (m) => void said.push(m),
      now: () => now,
    });

    expect(await scheduler.tick()).toEqual([]); // not yet

    now = new Date("2026-08-03T17:00:30Z");
    const fired = await scheduler.tick();
    expect(fired).toEqual([{ reflex: "call-khalid", status: "ok" }]);
    expect(said).toEqual(["⏰ Call Khalid about the invoice"]);

    now = new Date("2026-08-03T17:05:00Z");
    expect(await scheduler.tick()).toEqual([]); // disarmed — never fires twice
    expect(store.find("call-khalid")?.enabled).toBe(false);
  });

  it("a reflex must have either a habit or a message", () => {
    expect(() =>
      store.save({ name: "empty", at: "2026-08-03T17:00:00Z", enabled: true, createdAt: "now" }),
    ).toThrow(/habit to run, or a message/);
  });

  it("rejects an unreadable time at save, not at fire", () => {
    expect(() =>
      store.save({ name: "bad", message: "m", at: "not a time", enabled: true, createdAt: "now" }),
    ).toThrow(/not a valid time/);
  });
});

describe("reminders as the agent's tools", () => {
  it("sets, lists, and cancels through nodes", async () => {
    const store = new ReflexStore(dir());
    const [set, list, cancel] = reminderNodes(store);

    const out = await set.run({ when: "+30m", message: "stand up" }, [], { tenantId: "t" });
    expect(out[0].json.set).toBe(true);
    const name = out[0].json.name as string;

    const listed = await list.run({}, [], { tenantId: "t" });
    expect(listed[0].json.message).toBe("stand up");

    expect((await cancel.run({ name }, [], { tenantId: "t" }))[0].json.cancelled).toBe(true);
    expect((await list.run({}, [], { tenantId: "t" }))[0].json.empty).toBe(true);
  });
});
