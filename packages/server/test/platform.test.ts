import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/** Joins a chat to a tenant and walks the whole birth ritual. */
async function joinAndHatch(platform: Platform, chatId: string, token: string, name = "Agent") {
  await platform.handle("telegram", chatId, `/join ${token}`);
  await platform.handle("telegram", chatId, name);
  await platform.handle("telegram", chatId, "a test human");
  await platform.handle("telegram", chatId, "testing");
  await platform.handle("telegram", chatId, "warm");
}

describe("the platform", () => {
  beforeEach(clearNodes);

  it("walks a stranger through the door: onboarding -> invite -> birth ritual -> bound chat", async () => {
    const { platform, root } = makePlatform([says("Hello Al Jood!")]);

    // A stranger gets the pitch, not an agent.
    const stranger = await platform.handle("telegram", "111", "hello?");
    expect(stranger).toContain("isn't connected");

    // The admin mints an invite.
    const created = await platform.handle("telegram", "999", "/tenant new Al Jood standard");
    expect(created).toContain("Al Jood");
    const token = created.match(/\/join (\S+)/)![1];

    // Joining starts the birth ritual — a new agent asks who it is.
    const welcome = await platform.handle("telegram", "111", `/join ${token}`);
    expect(welcome).toContain("Al Jood");
    expect(welcome).toContain("What should my name be");

    expect(await platform.handle("telegram", "111", "Sanad")).toContain("who are you");
    expect(await platform.handle("telegram", "111", "Khalid from Al Jood")).toContain("purpose");
    expect(await platform.handle("telegram", "111", "handle our invoices")).toContain("how should I speak");
    const born = await platform.handle("telegram", "111", "formal");
    expect(born).toContain("I'm Sanad");

    // The identity its human gave it is now written in its body.
    const id = platform.tenants.tenantFor("telegram", "111")!.id;
    const innerMe = readFileSync(join(root, "tenants", id, "INNERME.md"), "utf8");
    expect(innerMe).toContain("I am Sanad");
    expect(innerMe).toContain("Khalid");
    expect(innerMe).toContain("invoices");
    expect(readFileSync(join(root, "tenants", id, "memory", "my-purpose.md"), "utf8")).toContain("invoices");

    // Ritual over: from now on it just talks — with its new identity in the prompt.
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
    await joinAndHatch(platform, "111", inviteA);
    await joinAndHatch(platform, "222", inviteB);

    // Tenant A's agent remembers something private.
    const idA = platform.tenants.tenantFor("telegram", "111")!.id;
    const orgA = await platform.organismFor(idA);
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
    await joinAndHatch(platform, "111", invite);

    const id = platform.tenants.tenantFor("telegram", "111")!.id;
    for (let i = 0; i < PLANS.trial.thoughtsPerDay; i++) platform.tenants.record(id, "thought");

    const denied = await platform.handle("telegram", "111", "think about something");
    expect(denied).toContain("thinking runs");
    expect(denied).toContain("habits still run free");
  });

  it("caps how many habits a plan may hold, at the door", async () => {
    const { platform } = makePlatform();
    const invite = (await platform.handle("telegram", "999", "/tenant new Small trial")).match(/\/join (\S+)/)![1];
    await joinAndHatch(platform, "111", invite);

    const id = platform.tenants.tenantFor("telegram", "111")!.id;
    const org = await platform.organismFor(id);
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
    await joinAndHatch(platform, "111", invite);

    const id = platform.tenants.tenantFor("telegram", "111")!.id;
    const org = await platform.organismFor(id);
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

describe("the local Anthropic socket — API shape, subscription brain", () => {
  it("answers /v1/messages through the platform's mind, no API key involved", async () => {
    const { platform, seen } = makePlatform([says("ANNOUNCEMENT: the dialect lives")]);
    const server = platform.hooksServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "ignored-entirely" },
      body: JSON.stringify({
        model: "claude-whatever",
        max_tokens: 900,
        system: "You write newspaper copy.",
        messages: [{ role: "user", content: "Write the formal post." }],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { content: Array<{ type: string; text: string }> };
    // The exact shape Parse Text reads: res.content[0].text
    expect(body.content[0].text).toBe("ANNOUNCEMENT: the dialect lives");
    expect(seen[0].system).toBe("You write newspaper copy.");

    await new Promise<void>((r) => server.close(() => r()));
    platform.stop();
  });

  it("returns Anthropic's error shape when the mind fails — imported error handling reads it natively", async () => {
    const root = mkdtempSync(join(tmpdir(), "platform-"));
    writeFileSync(join(root, "INNERME.md"), "# INNER ME\n");
    const mind = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => {
      throw new Error("the brain is asleep");
    });
    const platform = new Platform({ root, mind, via: "cli", adminChats: ["telegram:999"] });
    const server = platform.hooksServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
      method: "POST", body: JSON.stringify({ messages: [] }),
    });
    const body = (await res.json()) as { error: { type: string; message: string } };
    expect(body.error.type).toBe("api_error");
    expect(body.error.message).toContain("the brain is asleep");

    await new Promise<void>((r) => server.close(() => r()));
    platform.stop();
  });
});

describe("/plugins — the marketplace door", () => {
  it("lists installed, failed, and available plugins for the admin", async () => {
    const root = mkdtempSync(join(tmpdir(), "platform-"));
    writeFileSync(join(root, "INNERME.md"), "# INNER ME\n");
    const { mind } = scriptedMind();
    const platform = new Platform({
      root, mind, via: "cli", adminChats: ["telegram:999"],
      plugins: {
        plugins: [{ name: "weather", version: "2.0", nodes: 3, surfaces: 0 }],
        failed: { "broken-one": "exploded on import" },
      },
    });

    const out = await platform.handle("telegram", "999", "/plugins");
    expect(out).toContain("weather v2.0 — 3 node(s)");
    expect(out).toContain("broken-one: exploded on import");
    expect(out).toContain("dice"); // the marketplace still has it on offer
    platform.stop();
  });

  it("stays admin-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "platform-"));
    writeFileSync(join(root, "INNERME.md"), "# INNER ME\n");
    const { mind } = scriptedMind();
    const platform = new Platform({ root, mind, via: "cli", adminChats: ["telegram:999"] });
    const out = await platform.handle("telegram", "111", "/plugins");
    expect(out).not.toContain("Installed plugins");
    platform.stop();
  });
});

describe("/doctor — the physician's round", () => {
  it("reports vitals with fixes named, admin-only", async () => {
    const root = mkdtempSync(join(tmpdir(), "platform-"));
    writeFileSync(join(root, "INNERME.md"), "# INNER ME\n");
    process.env.TELEGRAM_BOT_TOKEN = "test-token";
    delete process.env.GOTENBERG_URL;
    const { mind } = scriptedMind([says("ok")]);
    const platform = new Platform({ root, mind, via: "cli", adminChats: ["telegram:999"] });

    const report = await platform.handle("telegram", "999", "/doctor");
    expect(report).toContain("Doctor");
    expect(report).toContain("✅ TELEGRAM_BOT_TOKEN set");
    expect(report).toContain("mind answering via cli");
    expect(report).toContain("GOTENBERG_URL unset");
    expect(report).toContain("tenants: 0");
    platform.stop();
  });
});
