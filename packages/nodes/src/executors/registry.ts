import type { Item, NodeContext } from "@squidclaw/kernel";

/**
 * Native node executor registry.
 *
 * n8n-step.ts hardcodes the ~19 core node types (code/if/switch/http/telegram/
 * files). Everything else — AI models, Slack, Gmail, Notion, … — plugs in here
 * as a registered executor instead of bloating that switch. The dispatcher's
 * `default` case consults this registry before declaring a type unsupported, so
 * a node either has a real executor or fails with a clear, honest message.
 *
 * An executor receives the already-resolved n8n `parameters` object, the input
 * items ({json, binary}), and the run context (tenantId for per-tenant
 * credentials). It returns output items in the same n8n-shaped envelope, so
 * data flows between native and registered nodes identically.
 */
export interface NodeExecutor {
  (
    parameters: Record<string, unknown>,
    items: Item[],
    ctx: NodeContext,
    /** The raw node params (type, credentials ref, __flow, …) for the rare executor that needs them. */
    raw: Record<string, unknown>,
  ): Promise<Item[]>;
}

const REGISTRY = new Map<string, NodeExecutor>();

/** Register an executor for an exact n8n node type, e.g. "n8n-nodes-base.slack". */
export function registerExecutor(type: string, fn: NodeExecutor): void {
  REGISTRY.set(type, fn);
}

/** Look up an executor. Returns undefined if the type has none. */
export function getExecutor(type: string): NodeExecutor | undefined {
  return REGISTRY.get(type);
}

/** Every registered type — lets isSupportedN8nType report the full picture. */
export function registeredTypes(): string[] {
  return [...REGISTRY.keys()];
}
