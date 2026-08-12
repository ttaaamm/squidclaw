import { cronMatches, parseCron, type CronSchedule } from "./cron.js";
import type { Reflex, ReflexStore } from "./store.js";

export interface FireResult {
  reflex: string;
  status: "ok" | "error";
  detail?: string;
}

/** Runs a habit by name with arguments. Supplied by the server, so this stays testable. */
export type RunHabit = (flow: string, args: Record<string, unknown>) => Promise<unknown>;

export interface SchedulerOptions {
  onFire?: (result: FireResult) => void;
  /** How a reminder reaches its human. Message-reflexes need this, not a habit. */
  say?: (message: string) => void | Promise<void>;
  /** How a prompt-reflex hands its instruction to the agent. */
  runPrompt?: (prompt: string) => void | Promise<void>;
  /** Injectable clock so tests don't wait for the wall to move. */
  now?: () => Date;
}

/**
 * The part that makes it alive rather than merely responsive: it acts at 9am
 * whether or not anyone is talking to it.
 */
export class Scheduler {
  private timer?: NodeJS.Timeout;
  private schedules = new Map<string, CronSchedule>();
  private lastFiredMinute = new Map<string, string>();
  private now: () => Date;

  constructor(
    private store: ReflexStore,
    private runHabit: RunHabit,
    private opts: SchedulerOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
  }

  private scheduleFor(reflex: Reflex): CronSchedule | undefined {
    if (!reflex.cron) return undefined;
    const cached = this.schedules.get(reflex.cron);
    if (cached) return cached;
    const parsed = parseCron(reflex.cron);
    this.schedules.set(reflex.cron, parsed);
    return parsed;
  }

  /** One pass. Public so a test — or a human — can make time move on demand. */
  async tick(): Promise<FireResult[]> {
    const at = this.now();
    const minuteKey = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}T${at.getHours()}:${at.getMinutes()}`;
    const fired: FireResult[] = [];

    for (const reflex of this.store.enabled()) {
      // One-shot reminders: fire once when due, then disarm forever.
      if (reflex.at) {
        if (Date.parse(reflex.at) > at.getTime()) continue;
        fired.push(await this.fire(reflex));
        this.store.setEnabled(reflex.name, false);
        continue;
      }
      const schedule = this.scheduleFor(reflex);
      if (!schedule || !cronMatches(schedule, at)) continue;
      // A tick that runs twice inside one minute must not fire twice.
      if (this.lastFiredMinute.get(reflex.name) === minuteKey) continue;
      this.lastFiredMinute.set(reflex.name, minuteKey);
      fired.push(await this.fire(reflex));
    }
    return fired;
  }

  async fire(reflex: Reflex): Promise<FireResult> {
    try {
      if (reflex.flow) {
        await this.runHabit(reflex.flow, reflex.args ?? {});
      } else if (reflex.prompt) {
        await this.opts.runPrompt?.(reflex.prompt);
      } else if (reflex.message) {
        await this.opts.say?.(`⏰ ${reflex.message}`);
      }
      this.store.recordRun(reflex.name, "ok");
      const result: FireResult = { reflex: reflex.name, status: "ok" };
      this.opts.onFire?.(result);
      return result;
    } catch (err) {
      this.store.recordRun(reflex.name, "error");
      const result: FireResult = { reflex: reflex.name, status: "error", detail: String(err) };
      this.opts.onFire?.(result);
      return result;
    }
  }

  /** Checks every 30s — cron resolves to the minute, so this never misses one. */
  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
}
