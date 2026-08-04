import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadPlugins, type PluginContext } from "@squidclaw/sdk";

/**
 * The plugin loader: contributions land, failures are named, and one broken
 * plugin never takes the platform down.
 */

const ctx = (): PluginContext => ({ workspace: "/tmp", env: process.env, log: () => {} });

function pluginDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "plugins-"));

  mkdirSync(join(dir, "dice"));
  writeFileSync(join(dir, "dice", "index.mjs"), `
export default {
  name: "dice", version: "1.0.0",
  nodes: () => [{
    name: "dice.roll", description: "roll", inputSchema: { type: "object", properties: {} },
    run: async () => [{ json: { rolled: 4 } }],
  }],
  surfaces: (ctx, onMessage) => [{
    started: false,
    async start() { this.started = true; this.reply = await onMessage("chat-1", "hello from the new door"); },
    async stop() {},
  }],
};
`);

  mkdirSync(join(dir, "broken"));
  writeFileSync(join(dir, "broken", "index.mjs"), `throw new Error("I explode on import");`);

  mkdirSync(join(dir, "empty-dir")); // no index at all

  return dir;
}

describe("loadPlugins", () => {
  it("collects nodes and surfaces; failures are named, never fatal", async () => {
    const handled: string[] = [];
    const loaded = await loadPlugins(pluginDir(), ctx(), (plugin) => async (chatId, text) => {
      handled.push(`${plugin}:${chatId}:${text}`);
      return "welcome";
    });

    expect(loaded.plugins).toEqual([
      { name: "dice", version: "1.0.0", description: undefined, nodes: 1, surfaces: 1 },
    ]);
    expect(loaded.nodes[0].name).toBe("dice.roll");
    expect((await loaded.nodes[0].run({}, [], { tenantId: "t" }))[0].json).toEqual({ rolled: 4 });

    // The surface got a working delivery lane, keyed by plugin name.
    await loaded.surfaces[0].start();
    expect(handled).toEqual(["dice:chat-1:hello from the new door"]);

    // The broken plugin is reported by name; the empty dir too.
    expect(loaded.failed.broken).toContain("I explode on import");
    expect(loaded.failed["empty-dir"]).toContain("no index.mjs");
  });

  it("a missing plugins directory is simply an empty arsenal", async () => {
    const loaded = await loadPlugins(join(tmpdir(), "definitely-not-here-xyz"), ctx());
    expect(loaded.plugins).toEqual([]);
    expect(loaded.nodes).toEqual([]);
  });

  it("a plugin whose node is malformed fails alone, loudly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plugins-"));
    mkdirSync(join(dir, "bad-node"));
    writeFileSync(join(dir, "bad-node", "index.mjs"), `
export default { name: "bad-node", nodes: () => [{ description: "no name, no run" }] };
`);
    const loaded = await loadPlugins(dir, ctx());
    expect(loaded.plugins).toEqual([]);
    expect(loaded.failed["bad-node"]).toContain("malformed");
  });
});
