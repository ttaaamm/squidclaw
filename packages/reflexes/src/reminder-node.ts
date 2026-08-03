import type { NodeDef } from "@squidclaw/kernel";
import type { ReflexStore } from "./store.js";

/**
 * "+30m", "+2h", "17:45", or a full ISO string → an ISO time.
 * Bare clock times mean today, or tomorrow if that moment already passed.
 */
export function parseWhen(when: string, now = new Date()): string {
  const trimmed = when.trim();

  const relative = trimmed.match(/^\+(\d+)\s*(m|min|minutes?|h|hours?|d|days?)$/i);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2][0].toLowerCase();
    const ms = unit === "m" ? n * 60_000 : unit === "h" ? n * 3_600_000 : n * 86_400_000;
    return new Date(now.getTime() + ms).toISOString();
  }

  const clock = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (clock) {
    const at = new Date(now);
    at.setHours(Number(clock[1]), Number(clock[2]), 0, 0);
    if (at.getTime() <= now.getTime()) at.setDate(at.getDate() + 1);
    return at.toISOString();
  }

  const parsed = Date.parse(trimmed);
  if (Number.isNaN(parsed)) {
    throw new Error(`I couldn't read "${when}" as a time — try "+30m", "+2h", "17:45", or a full date`);
  }
  return new Date(parsed).toISOString();
}

/** Reminders as tools — so "remind me at 5" is just the agent doing its job. */
export function reminderNodes(store: ReflexStore): NodeDef[] {
  return [
    {
      name: "reminder.set",
      description:
        'Set a one-shot reminder for the human. Params: when ("+30m", "+2h", "17:45", or ISO datetime), message (what to say when it fires). It fires once, then disarms.',
      inputSchema: {
        type: "object",
        required: ["when", "message"],
        properties: { when: { type: "string" }, message: { type: "string" } },
      },
      run: async (params) => {
        const at = parseWhen(String(params.when));
        const name = `remind-${Date.now().toString(36)}`;
        store.save({
          name,
          message: String(params.message),
          at,
          enabled: true,
          createdAt: new Date().toISOString(),
        });
        return [{ json: { set: true, name, firesAt: at, message: params.message } }];
      },
    },
    {
      name: "reminder.list",
      description: "List the reminders currently armed. No params.",
      inputSchema: { type: "object", properties: {} },
      run: async () => {
        const pending = store.enabled().filter((r) => r.at);
        return pending.length
          ? pending.map((r) => ({ json: { name: r.name, firesAt: r.at, message: r.message } }))
          : [{ json: { empty: true, note: "no reminders armed" } }];
      },
    },
    {
      name: "reminder.cancel",
      description: "Cancel an armed reminder. Params: name (from reminder.list).",
      inputSchema: { type: "object", required: ["name"], properties: { name: { type: "string" } } },
      run: async (params) => [{ json: { cancelled: store.remove(String(params.name)) } }],
    },
  ];
}
