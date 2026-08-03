/**
 * Standard 5-field cron: minute hour day-of-month month day-of-week.
 *
 * Written rather than borrowed because it's small, exactly specified, and the
 * thing that decides when the agent acts unasked should have no mystery in it.
 */

const BOUNDS: Array<[number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week — 0 and 7 both mean Sunday; 7 is normalized to 0 below
];

const NAMES: Array<Record<string, number>> = [
  {},
  {},
  {},
  { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 },
  { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 },
];

const ALIASES: Record<string, string> = {
  "@hourly": "0 * * * *",
  "@daily": "0 0 * * *",
  "@midnight": "0 0 * * *",
  "@weekly": "0 0 * * 0",
  "@monthly": "0 0 1 * *",
  "@yearly": "0 0 1 1 *",
  "@annually": "0 0 1 1 *",
};

export interface CronSchedule {
  expression: string;
  fields: Set<number>[];
  /** Cron's oldest quirk: when both day fields are restricted, either may match. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseField(raw: string, index: number): Set<number> {
  const [min, max] = BOUNDS[index];
  const out = new Set<number>();
  const named = (token: string): number => {
    const byName = NAMES[index][token.toLowerCase()];
    if (byName !== undefined) return byName;
    const n = Number(token);
    if (!Number.isInteger(n)) throw new Error(`cron: "${token}" is not a valid value`);
    return n;
  };

  for (const part of raw.split(",")) {
    const [range, stepRaw] = part.split("/");
    const step = stepRaw === undefined ? 1 : Number(stepRaw);
    if (!Number.isInteger(step) || step < 1) throw new Error(`cron: bad step "${stepRaw}"`);

    let from: number;
    let to: number;
    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      from = named(a);
      to = named(b);
    } else {
      from = named(range);
      to = stepRaw === undefined ? from : max;
    }

    if (from < min || to > max || from > to) {
      throw new Error(`cron: "${part}" out of range for field ${index} (${min}-${max})`);
    }
    for (let v = from; v <= to; v += step) out.add(index === 4 && v === 7 ? 0 : v);
  }
  return out;
}

export function parseCron(expression: string): CronSchedule {
  const normalized = ALIASES[expression.trim().toLowerCase()] ?? expression.trim();
  const parts = normalized.split(/\s+/);
  if (parts.length !== 5) throw new Error(`cron: expected 5 fields, got ${parts.length} in "${expression}"`);
  return {
    expression,
    fields: parts.map(parseField),
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

export function cronMatches(schedule: CronSchedule, at: Date): boolean {
  const [minute, hour, dom, month, dow] = schedule.fields;
  if (!minute.has(at.getMinutes())) return false;
  if (!hour.has(at.getHours())) return false;
  if (!month.has(at.getMonth() + 1)) return false;

  const domHit = dom.has(at.getDate());
  const dowHit = dow.has(at.getDay());

  if (schedule.domRestricted && schedule.dowRestricted) return domHit || dowHit;
  if (schedule.domRestricted) return domHit;
  if (schedule.dowRestricted) return dowHit;
  return true;
}

/** Next firing time strictly after `from`, or null if nothing matches within a year. */
export function nextRun(schedule: CronSchedule, from: Date): Date | null {
  const at = new Date(from.getTime());
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (cronMatches(schedule, at)) return at;
    at.setMinutes(at.getMinutes() + 1);
  }
  return null;
}
