import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { exportAgent, restoreAgent } from "./../src/backup.js";

describe("a whole agent in one file", () => {
  it("exports the body and restores it byte-identical elsewhere", () => {
    const home = mkdtempSync(join(tmpdir(), "agent-"));
    writeFileSync(join(home, "INNERME.md"), "# INNER ME\nI am Sanad.\n");
    mkdirSync(join(home, "memory"), { recursive: true });
    writeFileSync(join(home, "memory", "my-human.md"), "Tamer\n");
    mkdirSync(join(home, "flows"), { recursive: true });
    writeFileSync(join(home, "flows", "invoice.flow.json"), JSON.stringify({ name: "invoice" }));
    // Things that must NOT travel: temp hatching state, sqlite WAL files.
    writeFileSync(join(home, "HATCHING.json"), "{}");
    writeFileSync(join(home, "journal.db-wal"), "wal");

    const backup = exportAgent(home);
    expect(Object.keys(backup.files).sort()).toEqual([
      "INNERME.md", "flows/invoice.flow.json", "memory/my-human.md",
    ]);

    const reborn = mkdtempSync(join(tmpdir(), "reborn-"));
    expect(restoreAgent(backup, reborn)).toBe(3);
    expect(readFileSync(join(reborn, "INNERME.md"), "utf8")).toContain("Sanad");
    expect(existsSync(join(reborn, "HATCHING.json"))).toBe(false);
  });
});
