import { binaryBuffer, type NodeDef } from "@squidclaw/kernel";

export interface EmailConfig {
  user: string;
  pass: string;
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
}

/** Gmail works with just EMAIL_USER + EMAIL_PASS (an App Password). */
export function emailConfigFromEnv(env = process.env): EmailConfig | undefined {
  const user = env.EMAIL_USER;
  const pass = env.EMAIL_PASS;
  if (!user || !pass) return undefined;
  const gmail = user.endsWith("@gmail.com");
  return {
    user,
    pass,
    smtpHost: env.EMAIL_SMTP_HOST ?? (gmail ? "smtp.gmail.com" : `smtp.${user.split("@")[1]}`),
    smtpPort: Number(env.EMAIL_SMTP_PORT ?? 465),
    imapHost: env.EMAIL_IMAP_HOST ?? (gmail ? "imap.gmail.com" : `imap.${user.split("@")[1]}`),
    imapPort: Number(env.EMAIL_IMAP_PORT ?? 993),
  };
}

const NO_EARS =
  "email isn't configured — set EMAIL_USER and EMAIL_PASS (for Gmail: an App Password from myaccount.google.com/apppasswords)";

export interface SendTransport {
  (config: EmailConfig, mail: { to: string; subject: string; text: string; attachment?: { filename: string; content: Buffer } }): Promise<void>;
}

export interface ReadTransport {
  (config: EmailConfig, opts: { limit: number; unreadOnly: boolean }): Promise<
    Array<{ from: string; subject: string; date: string; snippet: string }>
  >;
}

const realSend: SendTransport = async (config, mail) => {
  const { default: nodemailer } = await import("nodemailer");
  const transporter = nodemailer.createTransport({
    host: config.smtpHost,
    port: config.smtpPort,
    secure: config.smtpPort === 465,
    auth: { user: config.user, pass: config.pass },
  });
  await transporter.sendMail({
    from: config.user,
    to: mail.to,
    subject: mail.subject,
    text: mail.text,
    attachments: mail.attachment ? [{ filename: mail.attachment.filename, content: mail.attachment.content }] : undefined,
  });
};

const realRead: ReadTransport = async (config, opts) => {
  const { ImapFlow } = await import("imapflow");
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: true,
    auth: { user: config.user, pass: config.pass },
    logger: false,
  });
  await client.connect();
  try {
    await client.mailboxOpen("INBOX");
    const search = opts.unreadOnly ? { seen: false } : { all: true };
    const uids = await client.search(search, { uid: true });
    const recent = (uids as number[]).slice(-opts.limit).reverse();
    const out: Array<{ from: string; subject: string; date: string; snippet: string }> = [];
    for await (const msg of client.fetch(
      recent.join(","),
      { envelope: true, bodyStructure: false, source: false, bodyParts: ["1"] },
      { uid: true },
    )) {
      const body = msg.bodyParts?.get("1")?.toString("utf8") ?? "";
      out.push({
        from: msg.envelope?.from?.map((a) => a.address ?? "").join(", ") ?? "",
        subject: msg.envelope?.subject ?? "",
        date: msg.envelope?.date?.toISOString() ?? "",
        snippet: body.replace(/\s+/g, " ").slice(0, 300),
      });
    }
    return out;
  } finally {
    await client.logout().catch(() => {});
  }
};

export function emailSendNode(transport: SendTransport = realSend, env = process.env): NodeDef {
  return {
    name: "email.send",
    description:
      "Send an email as the human's account. Params: to (required), subject (required), body (required). Binary flowing in from a previous node (a PDF, an image) is attached — give it a filename param.",
    inputSchema: {
      type: "object",
      required: ["to", "subject", "body"],
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
        filename: { type: "string" },
      },
    },
    run: async (params, items) => {
      const config = emailConfigFromEnv(env);
      if (!config) throw new Error(NO_EARS);
      const raw = items.find((i) => i.binary?.data)?.binary?.data;
      const binary = raw === undefined ? undefined : binaryBuffer(raw);
      await transport(config, {
        to: String(params.to),
        subject: String(params.subject),
        text: String(params.body),
        attachment:
          binary && params.filename ? { filename: String(params.filename), content: binary } : undefined,
      });
      return [{ json: { sent: true, to: params.to, subject: params.subject, attached: !!(binary && params.filename) } }];
    },
  };
}

export function emailReadNode(transport: ReadTransport = realRead, env = process.env): NodeDef {
  return {
    name: "email.read",
    description:
      "Read the inbox. Params: limit (default 5), unreadOnly (default true). Returns sender, subject, date and a snippet per message.",
    inputSchema: {
      type: "object",
      properties: { limit: { type: "number" }, unreadOnly: { type: "boolean" } },
    },
    run: async (params) => {
      const config = emailConfigFromEnv(env);
      if (!config) throw new Error(NO_EARS);
      const messages = await transport(config, {
        limit: (params.limit as number) ?? 5,
        unreadOnly: params.unreadOnly !== false,
      });
      return messages.length
        ? messages.map((m) => ({ json: { ...m } }))
        : [{ json: { empty: true, note: "no messages matched" } }];
    },
  };
}
