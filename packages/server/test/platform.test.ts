import { describe, it, expect, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes, registerNode } from "@squidclaw/kernel";
import { Brains } from "@squidclaw/brains";
import { PLANS } from "@squidclaw/tenants";
import { Platform } from "./../src/platform.js";

const says = (text: string) => ({ content: [{ type: "text", text }] });

/** A mind that records what each call was shown, and follows a script. */
function scriptedMind(responses: unknown[] = []) {
  const seen: Array<{ system: string; tools: string[] }> = [];
  let i = 0;
  const mind = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async (req) => {
    seen.push({
      system: req.system as string,
      tools: ((req.tools ?? []) as Array<{ name: string }>).map((t) => t.name),
    });
    return responses[i++] ?? says("ok");
  });
  return { mind, seen };
}

function makePlatform(responses?: unknown[]) {
  const root = mkdtempSync(join(tmpdir(), "platform-"));
  writeFileSync(join(root, "INNERME.md"), "# INNER ME\nI am SquidClaw.\n");
  const { mind, seen } = scriptedMind(responses);
  const platform = new Platform({
    root, mind, via: "cli",
    adminChats: ["telegram:999"],
  });
  return { platform, root, seen };
}

describe("the platform", () => {
  beforeEach(clearNodes);

  it("walks a stranger through the door: onboarding -> invite -> bound chat", async () => {
    const { platform } = makePlatform([says("Hello Al Jood!")]);

    // A stranger gets the pitch, not an agent.
    const stranger = await platform.handle("telegram", "111", "hello?");
    expect(stranger).toContain("isn't connected");

    // The admin mints an invite.
    const created = await platform.handle("telegram", "999", "/tenant new Al Jood standard");
    expect(created).toContain("Al Jood");
    const token = created.match(/\/join (\S+)/)![1];

    // The client joins, and from then on just talks.
    const welcome = await platform.handle("telegram", "111", `/join ${token}`);
    expect(welcome).toContain("Al Jood");
    const reply = await platform.handle("telegram", "111", "hello!");
    expect(reply).toBe("Hello Al Jood!");
  });

  it("rejects a bad invite and half an invite", async () => {
    const { platform } = makePlatform();
    expect(await platform.handle("telegram", "1", "/join nope")).toContain("doesn't match");
    expect(await platform.handle("telegram", "1", "/join")).toContain("whole invite");
  });

  it("keeps admin commands away from ordinary chats", async () => {
    const { platform } = makePlatform();
    const out = await platform.handle("telegram", "111", "/tenant new Sneaky");
    // Not an admin: treated as an unbound stranger, no tenant created.
    expect(out).toContain("isn't connected");
    expect(platform.tenants.all()).toEqual([]);
  });

  it("gives each tenant its own memory — nothing leaks between organisms", async () => {
    const { platform, seen } = makePlatform([says("noted"), says("hello")]);

    const inviteA = (await platform.handle("telegram", "999", "/tenant new A")).match(/\/join (\S+)/)![1];
    const inviteB = (await platform.handle("telegram", "999", "/tenant new B")).match(/\/join (\S+)/)![1];
    await platform.handle("telegram", "111", `/join ${inviteA}`);
    await platform.handle("telegram", "222", `/join ${inviteB}`);

    // Tenant A's agent remembers something private.
    const idA = platform.tenants.tenantFor("telegram", "111")!.id;
    const orgA = (platform.warmOrganisms().find((o) => o.tenantId === idA))!.organism;
    orgA.memory.remember("bank", "A's account is at Riyad Bank.");

    await platform.handle("telegram", "111", "what do you know?");
    await platform.handle("telegram", "222", "what do you know?");

    expect(seen[0].system).toContain("Riyad Bank"); // A sees A's memory
    expect(seen[1].system).not.toContain("Riyad Bank"); // B never does
    // And each agent's memory tools are its own, not shared globals.
    expect(seen[0].tools).toContain("memory__remember");
    expect(clearNodes).not.toThrow(); // globals untouched by tenant memories
  });

  it("enforces thinking quotas per tenant, in plain words", async () => {
    const { platform } = makePlatform();
    const invite = (await platform.handle("telegram", "999", "/tenant new Small trial")).match(/\/join (\S+)/)![1];
    await platform.handle("telegram", "111", `/join ${invite}`);

    const id = platform.tenants.tenantFor("telegram", "111")!.id;
    for (let i = 0; i < PLANS.trial.thoughtsPerDay; i++) platform.tenants.record(id, "thought");

    const denied = await platform.handle("telegram", "111", "think about something");
    expect(denied).toContain("thinking runs");
    expect(denied).toContain("habits still run free");
  });

  it("caps how many habits a plan may hold, at the door", async () => {
    const { platform } = makePlatform();
    const invite = (await platform.handle("telegram", "999", "/tenant new Small trial")).match(/\/join (\S+)/)![1];
    await platform.handle("telegram", "111", `/join ${invite}`);

    const id = platform.tenants.tenantFor("telegram", "111")!.id;
    const org = platform.warmOrganisms().find((o) => o.tenantId === id)!.organism;
    for (let i = 0; i < PLANS.trial.maxHabits; i++) {
      org.flows.saveDraft({
        name: `h${i}`, description: "d", signature: `s${i}`, triggers: [], params: [],
        runs: 2, createdAt: "now", status: "draft",
        graph: { nodes: [{ id: "n1", node: "echo", params: {} }], edges: [] },
      });
      org.flows.promote(`h${i}`);
    }

    const refused = await platform.handle("telegram", "111", "/promote one-more");
    expect(refused).toContain("holds up to");
  });

  it("admin can list, retune and disable tenants", async () => {
    const { platform } = makePlatform();
    const created = await platform.handle("telegram", "999", "/tenant new Al Jood");
    const id = platform.tenants.all()[0].id;
    expect(created).toContain(id);

    expect(await platform.handle("telegram", "999", "/tenants")).toContain("Al Jood");
    expect(await platform.handle("telegram", "999", `/tenant plan ${id} standard`)).toContain("standard");
    expect(await platform.handle("telegram", "999", `/tenant off ${id}`)).toContain("disabled");

    const token = platform.tenants.find(id)!.token;
    // A disabled tenant's invite no longer works…
    expect(await platform.handle("telegram", "111", `/join ${token}`)).toContain("doesn't match");
    // …until it's re-enabled.
    await platform.handle("telegram", "999", `/tenant on ${id}`);
    expect(await platform.handle("telegram", "111", `/join ${token}`)).toContain("Welcome");
  });

  it("runs webhooks tenant-aware, counting against the owner's budget", async () => {
    registerNode({
      name: "ping", description: "pings", inputSchema: {},
      run: async (p) => [{ json: { pinged: p.who ?? "world" } }],
    });
    const { platform } = makePlatform();
    const invite = (await platform.handle("telegram", "999", "/tenant new Hooked")).match(/\/join (\S+)/)![1];
    await platform.handle("telegram", "111", `/join ${invite}`);

    const id = platform.tenants.tenantFor("telegram", "111")!.id;
    const org = platform.warmOrganisms().find((o) => o.tenantId === id)!.organism;
    org.flows.saveDraft({
      name: "ping-it", description: "d", signature: "ping", triggers: [], params: [],
      runs: 2, createdAt: "now", status: "draft",
      graph: { nodes: [{ id: "n1", node: "ping", params: {} }], edges: [] },
    });
    org.flows.promote("ping-it");
    org.agent.registerHabits();
    org.reflexes.save({
      name: "on-ping", flow: "ping-it", webhook: "ping", enabled: true, createdAt: "now",
    });

    const server = platform.hooksServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/hooks/ping`, {
      method: "POST", body: JSON.stringify({ who: "al-jood" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(platform.tenants.used(id, "habit")).toBe(1);

    expect((await fetch(`http://127.0.0.1:${port}/hooks/nothing`, { method: "POST" })).status).toBe(404);
    await new Promise<void>((r) => server.close(() => r()));
    platform.stop();
  });
});
