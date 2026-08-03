import type { ExecutionRecord, StepRecord } from "@squidclaw/kernel";

export type Ailment = "transient" | "broken" | "unknown";

export interface Diagnosis {
  ailment: Ailment;
  reason: string;
  step?: StepRecord;
}

const TRANSIENT = [
  /ECONNRESET/i, /ECONNREFUSED/i, /ETIMEDOUT/i, /EAI_AGAIN/i, /ENOTFOUND/i,
  /socket hang up/i, /network|fetch failed/i, /timed? ?out/i,
  /\b(429|500|502|503|504)\b/,
];

const BROKEN = [
  /unknown node/i, /not registered/i, /unsupported imported node/i,
  /missing (required )?param/i, /\b(400|401|403|404|422)\b/,
  /is not a function/i, /cannot read propert/i,
];

/**
 * Reads a failure the way an on-call engineer would: is this the world being
 * flaky, or is the habit itself wrong? The answer decides whether to wait or
 * to wake a human.
 */
export function diagnose(execution: ExecutionRecord): Diagnosis {
  const step = execution.steps.find((s) => s.status === "error");
  if (!step) return { ailment: "unknown", reason: "no failing step recorded" };

  const message = step.error ?? "";
  if (TRANSIENT.some((p) => p.test(message))) {
    return { ailment: "transient", reason: `${step.node}: the world was flaky — ${message.slice(0, 200)}`, step };
  }
  if (BROKEN.some((p) => p.test(message))) {
    return { ailment: "broken", reason: `${step.node}: the habit itself is wrong — ${message.slice(0, 200)}`, step };
  }
  return { ailment: "unknown", reason: `${step.node}: ${message.slice(0, 200)}`, step };
}

export interface HealOptions {
  /** How many times to retry something the world merely fumbled. */
  maxRetries?: number;
  /** Base backoff in ms; doubles each attempt. */
  backoffMs?: number;
  /** Injectable so tests don't actually wait. */
  sleep?: (ms: number) => Promise<void>;
  /** How the agent reaches a human when it can't fix things itself. */
  notify?: (message: string) => Promise<void> | void;
}

export interface HealResult {
  healed: boolean;
  attempts: number;
  diagnosis: Diagnosis;
  /** What a human was told, if anything. */
  escalated?: string;
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Retries what deserves retrying, escalates what doesn't — in plain language,
 * because the human reading it at 3am shouldn't have to parse a stack trace.
 */
export async function heal(
  execution: ExecutionRecord,
  rerun: () => Promise<ExecutionRecord>,
  opts: HealOptions = {},
): Promise<HealResult> {
  const diagnosis = diagnose(execution);
  const maxRetries = opts.maxRetries ?? 3;
  const backoff = opts.backoffMs ?? 1000;
  const sleep = opts.sleep ?? wait;

  if (diagnosis.ailment !== "transient") {
    const message =
      diagnosis.ailment === "broken"
        ? `I couldn't fix this myself — ${diagnosis.reason}. The habit needs changing.`
        : `Something failed in a way I don't recognise — ${diagnosis.reason}.`;
    await opts.notify?.(message);
    return { healed: false, attempts: 0, diagnosis, escalated: message };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    await sleep(backoff * 2 ** (attempt - 1));
    const rerunResult = await rerun();
    if (rerunResult.status === "ok") {
      return { healed: true, attempts: attempt, diagnosis };
    }
    // A retry that fails differently is no longer the same problem.
    const next = diagnose(rerunResult);
    if (next.ailment !== "transient") {
      const message = `Retried ${attempt}× and it changed its mind about failing — ${next.reason}.`;
      await opts.notify?.(message);
      return { healed: false, attempts: attempt, diagnosis: next, escalated: message };
    }
  }

  const message = `Tried ${maxRetries} times over ${
    (backoff * (2 ** maxRetries - 1)) / 1000
  }s and it kept failing — ${diagnosis.reason}.`;
  await opts.notify?.(message);
  return { healed: false, attempts: maxRetries, diagnosis, escalated: message };
}
