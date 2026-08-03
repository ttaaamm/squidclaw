import { describe, it, expect } from "vitest";
import { emailConfigFromEnv, emailSendNode, emailReadNode, type EmailConfig } from "@squidclaw/nodes";

const env = { EMAIL_USER: "tamer@gmail.com", EMAIL_PASS: "app-password" };

describe("email configuration", () => {
  it("derives gmail hosts from just user + app password", () => {
    const config = emailConfigFromEnv(env)!;
    expect(config.smtpHost).toBe("smtp.gmail.com");
    expect(config.imapHost).toBe("imap.gmail.com");
    expect(config.smtpPort).toBe(465);
  });

  it("is absent without credentials, and the nodes explain what's missing", async () => {
    expect(emailConfigFromEnv({})).toBeUndefined();
    await expect(emailSendNode(async () => {}, {}).run(
      { to: "a@b.c", subject: "s", body: "b" }, [], { tenantId: "t" },
    )).rejects.toThrow(/EMAIL_USER and EMAIL_PASS/);
  });
});

describe("email.send", () => {
  it("sends through the transport, attaching binary that flows in", async () => {
    const sent: Array<{ config: EmailConfig; mail: Record<string, unknown> }> = [];
    const node = emailSendNode(async (config, mail) => void sent.push({ config, mail: mail as never }), env);

    const pdf = Buffer.from("%PDF-1.4 invoice");
    const out = await node.run(
      { to: "khalid@aljood.sa", subject: "Invoice #42", body: "Attached.", filename: "invoice-42.pdf" },
      [{ json: {}, binary: { data: pdf } }],
      { tenantId: "t" },
    );

    expect(out[0].json).toMatchObject({ sent: true, attached: true });
    expect(sent[0].config.user).toBe("tamer@gmail.com");
    expect(sent[0].mail.to).toBe("khalid@aljood.sa");
    expect((sent[0].mail.attachment as { filename: string }).filename).toBe("invoice-42.pdf");
  });

  it("sends plain text without an attachment when no binary flows in", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const node = emailSendNode(async (_c, mail) => void sent.push(mail as never), env);
    const out = await node.run({ to: "a@b.c", subject: "hi", body: "text" }, [], { tenantId: "t" });
    expect(out[0].json.attached).toBe(false);
    expect(sent[0].attachment).toBeUndefined();
  });
});

describe("email.read", () => {
  it("lists the inbox through the transport", async () => {
    const node = emailReadNode(async (_config, opts) => {
      expect(opts).toEqual({ limit: 2, unreadOnly: true });
      return [
        { from: "khalid@aljood.sa", subject: "Re: Invoice", date: "2026-08-03", snippet: "Received, thanks." },
        { from: "news@x.com", subject: "Digest", date: "2026-08-03", snippet: "..." },
      ];
    }, env);

    const out = await node.run({ limit: 2 }, [], { tenantId: "t" });
    expect(out).toHaveLength(2);
    expect(out[0].json.from).toContain("khalid");
  });

  it("says the inbox is quiet rather than returning nothing", async () => {
    const node = emailReadNode(async () => [], env);
    const out = await node.run({}, [], { tenantId: "t" });
    expect(out[0].json.empty).toBe(true);
  });
});
