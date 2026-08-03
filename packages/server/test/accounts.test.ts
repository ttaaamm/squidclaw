import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { clearNodes } from "@squidclaw/kernel";
import { Brains } from "@squidclaw/brains";
import { LoginStore } from "@squidclaw/tenants";
import { DashboardServer } from "@squidclaw/canvas";
import { Platform } from "./../src/platform.js";

const says = (text: string) => ({ content: [{ type: "text", text }] });

function makePlatform() {
  const root = mkdtempSync(join(tmpdir(), "acct-"));
  writeFileSync(join(root, "INNERME.md"), "# INNER ME\nI am SquidClaw.\n");
  const mind = new Brains({ tiers: { cheap: ["m"], strong: ["m"] } }, async () => says("ok"));
  const platform = new Platform({
    root, mind, via: "cli",
    adminChats: ["telegram:999"],
    publicUrl: "https://flow.preplix.ai",
  });
  return { platform, root };
}

async function joinAndHatch(platform: Platform, chatId: string, token: string) {
  await platform.handle("telegram", chatId, `/join ${token}`);
  for (const answer of ["Agent", "a human", "testing", "warm"]) {
    await platform.handle("telegram", chatId, answer);
  }
}

describe("passwordless sign-in", () => {
  it("codes are single-use and expire; sessions persist", () => {
    const logins = new LoginStore(":memory:");
    const code = logins.mintCode("t1");
    expect(logins.redeemCode(code)).toBe("t1");
    expect(logins.redeemCode(code)).toBeUndefined(); // burned

    const sid = logins.createSession("t1");
    expect(logins.sessionTenant(sid)).toBe("t1");
    logins.destroySession(sid);
    expect(logins.sessionTenant(sid)).toBeUndefined();
  });
});

describe("/canvas from chat", () => {
  beforeEach(clearNodes);

  it("mints a personal one-time sign-in link", async () => {
    const { platform } = makePlatform();
    const invite = (await platform.handle("telegram", "999", "/tenant new Al Jood")).match(/\/join (\S+)/)![1];
    await joinAndHatch(platform, "111", invite);

    const reply = await platform.handle("telegram", "111", "/canvas");
    expect(reply).toContain("https://flow.preplix.ai/login?code=");

    const code = reply.match(/code=(\S+)/)![1];
    const tenantId = platform.tenants.tenantFor("telegram", "111")!.id;
    expect(platform.logins.redeemCode(code)).toBe(tenantId);
  });
});

describe("the multi-tenant canvas", () => {
  beforeEach(clearNodes);

  async function servedPlatform() {
    const { platform } = makePlatform();
    const inviteA = (await platform.handle("telegram", "999", "/tenant new A")).match(/\/join (\S+)/)![1];
    const inviteB = (await platform.handle("telegram", "999", "/tenant new B")).match(/\/join (\S+)/)![1];
    await joinAndHatch(platform, "111", inviteA);
    await joinAndHatch(platform, "222", inviteB);
    const idA = platform.tenants.tenantFor("telegram", "111")!.id;
    const idB = platform.tenants.tenantFor("telegram", "222")!.id;

    // Give each tenant something recognisable to see.
    (await platform.organismFor(idA)).memory.remember("secret-a", "A's bank is Riyad Bank");
    (await platform.organismFor(idB)).memory.remember("secret-b", "B's bank is SNB");

    const server = new DashboardServer(
      { journal: (await platform.organismFor(idA)).journal, flows: (await platform.organismFor(idA)).flows,
        reflexes: (await platform.organismFor(idA)).reflexes, mind: { via: "cli", tools: 0 } },
      {
        token: "admin-master-token",
        auth: {
          redeemCode: (c) => platform.logins.redeemCode(c),
          createSession: (t) => platform.logins.createSession(t),
          sessionTenant: (s) => platform.logins.sessionTenant(s),
          sourcesFor: (t) => platform.sourcesFor(t),
        },
      },
    );
    const port = await server.listen(0);
    return { platform, server, port, idA, idB };
  }

  it("login exchanges a code for a session scoped to one tenant — walls hold", async () => {
    const { platform, server, port, idA, idB } = await servedPlatform();
    try {
      // Sign in as tenant A.
      const code = platform.logins.mintCode(idA);
      const login = await fetch(`http://127.0.0.1:${port}/login?code=${code}`, { redirect: "manual" });
      expect(login.status).toBe(302);
      const cookie = login.headers.get("set-cookie")!;
      expect(cookie).toContain("sc_session=");
      expect(cookie).toContain("HttpOnly");

      // A sees A's mind…
      const sid = cookie.match(/sc_session=([^;]+)/)![1];
      const state = (await (
        await fetch(`http://127.0.0.1:${port}/api/state`, { headers: { cookie: `sc_session=${sid}` } })
      ).json()) as { memories: Array<{ content: string }> };
      const memories = JSON.stringify(state.memories);
      expect(memories).toContain("Riyad Bank");
      expect(memories).not.toContain("SNB"); // …and provably never B's

      // Reusing the burned code fails.
      expect((await fetch(`http://127.0.0.1:${port}/login?code=${code}`, { redirect: "manual" })).status).toBe(401);

      // No session, no admin token → nothing.
      expect((await fetch(`http://127.0.0.1:${port}/api/state`)).status).toBe(401);

      // The admin master token still opens the master view.
      expect(
        (await fetch(`http://127.0.0.1:${port}/api/state?token=admin-master-token`)).status,
      ).toBe(200);

      void idB;
    } finally {
      await server.close();
      platform.stop();
    }
  });
});

describe("the Preplix handshake", () => {
  beforeEach(clearNodes);

  it("maps an outside account to exactly one tenant, and mints SSO links", async () => {
    const { platform } = makePlatform();

    const first = platform.linkPartnerAccount("supabase-user-42", "Tamer (Preplix)");
    const again = platform.linkPartnerAccount("supabase-user-42", "different name, same person");
    expect(again.tenant.id).toBe(first.tenant.id); // one account, one tenant, forever
    expect(first.invite).toMatch(/^\/join /);
    expect(first.canvasLink).toContain("/login?code=");

    // The SSO link signs in as that tenant.
    const code = again.canvasLink.match(/code=(\S+)/)![1];
    expect(platform.logins.redeemCode(code)).toBe(first.tenant.id);
  });

  it("guards the partner API with the bearer key", async () => {
    const { platform } = makePlatform();
    const server = platform.hooksServer(undefined, "partner-secret");
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as { port: number }).port;

    try {
      const noKey = await fetch(`http://127.0.0.1:${port}/partner/link`, {
        method: "POST", body: JSON.stringify({ externalId: "u1" }),
      });
      expect(noKey.status).toBe(401);

      const linked = await fetch(`http://127.0.0.1:${port}/partner/link`, {
        method: "POST",
        headers: { authorization: "Bearer partner-secret", "content-type": "application/json" },
        body: JSON.stringify({ externalId: "u1", name: "Khalid" }),
      });
      expect(linked.status).toBe(200);
      const body = (await linked.json()) as { tenantId: string; invite: string; canvasLink: string };
      expect(body.invite).toContain("/join");
      expect(body.canvasLink).toContain("/login?code=");

      const sso = await fetch(`http://127.0.0.1:${port}/partner/sso`, {
        method: "POST",
        headers: { authorization: "Bearer partner-secret", "content-type": "application/json" },
        body: JSON.stringify({ externalId: "u1" }),
      });
      expect(((await sso.json()) as { canvasLink: string }).canvasLink).toContain("/login?code=");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      platform.stop();
    }
  });
});
