import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseCron } from "./cron.js";

/** A standing commitment: run this habit when this happens, without being asked. */
export interface Reflex {
  name: string;
  /** The habit to run — a promoted flow's name. */
  flow: string;
  args?: Record<string, unknown>;
  /** 5-field cron, or an alias like @daily. */
  cron?: string;
  /** Webhook path segment: POST /hooks/<webhook> fires it. */
  webhook?: string;
  enabled: boolean;
  createdAt: string;
  lastRun?: string;
  lastStatus?: "ok" | "error";
}

const FILE = /\.trigger\.json$/;

export class ReflexStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true });
  }

  all(): Reflex[] {
    if (!existsSync(this.dir)) return [];
    return readdirSync(this.dir)
      .filter((f) => FILE.test(f))
      .map((f) => JSON.parse(readFileSync(join(this.dir, f), "utf8")) as Reflex);
  }

  enabled(): Reflex[] {
    return this.all().filter((r) => r.enabled);
  }

  find(name: string): Reflex | undefined {
    return this.all().find((r) => r.name === name);
  }

  save(reflex: Reflex): void {
    if (!reflex.cron && !reflex.webhook) {
      throw new Error(`reflex "${reflex.name}" needs a cron schedule or a webhook path`);
    }
    if (reflex.cron) parseCron(reflex.cron); // fail loudly now, not at 3am
    writeFileSync(join(this.dir, `${reflex.name}.trigger.json`), `${JSON.stringify(reflex, null, 2)}\n`, "utf8");
  }

  setEnabled(name: string, enabled: boolean): boolean {
    const reflex = this.find(name);
    if (!reflex) return false;
    this.save({ ...reflex, enabled });
    return true;
  }

  recordRun(name: string, status: "ok" | "error"): void {
    const reflex = this.find(name);
    if (!reflex) return;
    this.save({ ...reflex, lastRun: new Date().toISOString(), lastStatus: status });
  }

  remove(name: string): boolean {
    const path = join(this.dir, `${name}.trigger.json`);
    if (!existsSync(path)) return false;
    unlinkSync(path);
    return true;
  }
}
