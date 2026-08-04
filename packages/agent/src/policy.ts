import type { Item, NodeContext, NodeDef } from "@squidclaw/kernel";

/**
 * The tool policy gate — one door every tool call walks through, whichever
 * mind is calling. Correctness enforced in structure: a malformed or
 * placeholder-shaped call is refused HERE, uniformly, with a message the
 * model can act on — instead of each flow and node inventing its own guard.
 *
 * (OpenClaw runs its agent tools through exactly this shape: schemas +
 * policy + before/after hooks around every call.)
 */

/** A refusal the model is meant to read and correct — not a crash. */
export class PolicyRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyRefusal";
  }
}

export interface ToolPolicy {
  name: string;
  /** Inspect a call before it runs. Throw PolicyRefusal to refuse it. */
  before?: (tool: string, params: Record<string, unknown>) => void;
  /** Inspect or transform output after a successful run. */
  after?: (tool: string, params: Record<string, unknown>, output: Item[]) => Item[];
}

/**
 * Required fields must actually be there. The model gets one clear sentence
 * naming what's missing instead of whatever stack trace the node would have
 * produced three steps later.
 */
function requireFields(def: NodeDef, params: Record<string, unknown>): void {
  const schema = def.inputSchema as { required?: string[] } | undefined;
  for (const field of schema?.required ?? []) {
    const value = params[field];
    if (value === undefined || value === null || String(value).trim() === "") {
      throw new PolicyRefusal(
        `${def.name} needs "${field}" and it wasn't given. Supply a real value — if only the human knows it, ask them and wait.`,
      );
    }
  }
}

/**
 * Placeholder-shaped values never reach a tool. Narrow on purpose: angle
 * bracket templates and bare TODO markers are always wrong; anything softer
 * belongs in a flow's own param contract (reject) where context is known.
 */
const PLACEHOLDER_VALUE = /^<[^<>]{1,60}>$|^(TODO|TBD|xxx+|placeholder)$/i;

export const placeholderPolicy: ToolPolicy = {
  name: "placeholder",
  before: (tool, params) => {
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === "string" && PLACEHOLDER_VALUE.test(value.trim())) {
        throw new PolicyRefusal(
          `${tool}: "${key}" is a placeholder ("${value.trim()}"), not a real value. Use what the human actually said — or ask them.`,
        );
      }
    }
  },
};

export const DEFAULT_POLICIES: ToolPolicy[] = [placeholderPolicy];

/**
 * The one place a tool actually runs. Both minds call through here — the
 * classic loop directly, the deep harness via the bridge — so a policy added
 * once holds everywhere.
 */
export async function executeTool(
  def: NodeDef,
  params: Record<string, unknown>,
  ctx: NodeContext,
  policies: ToolPolicy[] = DEFAULT_POLICIES,
): Promise<Item[]> {
  requireFields(def, params);
  for (const policy of policies) policy.before?.(def.name, params);
  let output = await def.run(params, [], ctx);
  for (const policy of policies) {
    if (policy.after) output = policy.after(def.name, params, output);
  }
  return output;
}
