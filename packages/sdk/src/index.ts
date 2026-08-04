import { readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { NodeDef } from "@squidclaw/kernel";

/**
 * The SquidClaw Plugin SDK — the formal contract strangers can build against.
 *
 * A plugin is a directory under <workspace>/plugins containing an index.mjs
 * whose default export satisfies SquidClawPlugin. Whatever it contributes
 * lands everywhere at once, like every organ here: tools become nodes AND
 * mind-tools AND flow steps AND canvas neurons; surfaces become new doors
 * into the same being (Discord, Slack, anything with messages).
 *
 * One broken plugin must never take the platform down — each loads inside
 * its own failure boundary and is reported by name.
 */

export interface PluginContext {
  /** The platform workspace root (shared, not a tenant's body). */
  workspace: string;
  env: NodeJS.ProcessEnv;
  log: (message: string) => void;
}

/** What a channel surface must be able to do — start listening, stop cleanly. */
export interface PluginSurface {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Deliver one inbound message to the agent; the resolved string is the reply. */
export type PluginMessageHandler = (
  chatId: string,
  text: string,
  progress?: (note: string) => void,
) => Promise<string>;

export interface SquidClawPlugin {
  name: string;
  version?: string;
  description?: string;
  /** Tools this plugin contributes. */
  nodes?: (ctx: PluginContext) => NodeDef[] | Promise<NodeDef[]>;
  /** Chat channels this plugin opens; messages route through the handler. */
  surfaces?: (
    ctx: PluginContext,
    onMessage: PluginMessageHandler,
  ) => PluginSurface[] | Promise<PluginSurface[]>;
}

/**
 * The marketplace, v1: a curated registry of known-good plugins. Installing
 * is deliberate and boring — copy the plugin directory into
 * <workspace>/plugins and restart. No auto-downloads of strangers' code
 * onto a production box; that restraint IS the feature.
 */
export interface MarketplaceEntry {
  name: string;
  description: string;
  source: string;
}

export const MARKETPLACE: MarketplaceEntry[] = [
  {
    name: "dice",
    description: "Dice rolls as a tool — the hello-world reference plugin, small enough to read in one breath.",
    source: "examples/plugins/dice in the SquidClaw repo",
  },
];

export interface LoadedPlugins {
  plugins: Array<{ name: string; version?: string; description?: string; nodes: number; surfaces: number }>;
  nodes: NodeDef[];
  surfaces: PluginSurface[];
  /** Plugin name (or directory) → why it failed. Loud, named, non-fatal. */
  failed: Record<string, string>;
}

/**
 * Loads every plugin under `dir`. `makeHandler` gives each plugin's surfaces
 * their own delivery lane, keyed by plugin name — so a Discord plugin's
 * chats bind as surface "plugin:discord".
 */
export async function loadPlugins(
  dir: string,
  ctx: PluginContext,
  makeHandler?: (pluginName: string) => PluginMessageHandler,
): Promise<LoadedPlugins> {
  const out: LoadedPlugins = { plugins: [], nodes: [], surfaces: [], failed: {} };
  if (!existsSync(dir)) return out;

  for (const entry of readdirSync(dir)) {
    const root = join(dir, entry);
    try {
      if (!statSync(root).isDirectory()) continue;
      const main = ["index.mjs", "index.js"].map((f) => join(root, f)).find(existsSync);
      if (!main) {
        out.failed[entry] = "no index.mjs (or index.js) in the plugin directory";
        continue;
      }
      const mod = (await import(pathToFileURL(main).href)) as { default?: SquidClawPlugin; plugin?: SquidClawPlugin };
      const plugin = mod.default ?? mod.plugin;
      if (!plugin?.name) {
        out.failed[entry] = "default export is not a SquidClawPlugin (missing name)";
        continue;
      }

      const nodes = plugin.nodes ? await plugin.nodes(ctx) : [];
      for (const node of nodes) {
        if (!node?.name || typeof node.run !== "function") {
          throw new Error(`node ${String(node?.name ?? "?")} is malformed (needs name + run)`);
        }
      }

      const surfaces =
        plugin.surfaces && makeHandler ? await plugin.surfaces(ctx, makeHandler(plugin.name)) : [];

      out.nodes.push(...nodes);
      out.surfaces.push(...surfaces);
      out.plugins.push({
        name: plugin.name,
        version: plugin.version,
        description: plugin.description,
        nodes: nodes.length,
        surfaces: surfaces.length,
      });
      ctx.log(`plugin ${plugin.name}: ${nodes.length} node(s), ${surfaces.length} surface(s)`);
    } catch (err) {
      out.failed[entry] = String(err instanceof Error ? err.message : err);
      ctx.log(`plugin ${entry} FAILED to load: ${out.failed[entry]}`);
    }
  }
  return out;
}
