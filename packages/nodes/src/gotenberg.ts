import type { NodeDef } from "@squidclaw/kernel";

export interface GotenbergOptions {
  /** Overridable for tests; defaults to GOTENBERG_URL or the aljoodbs box's local port. */
  baseUrl?: string;
}

/**
 * HTML in, pixel-perfect PDF out — via the same Gotenberg the Saudi Times
 * bots already trust.
 *
 * The one lesson that cost us twice in n8n is baked into the description and
 * the code: Gotenberg only renders the file named index.html.
 */
export function gotenbergRenderNode(opts: GotenbergOptions = {}): NodeDef {
  return {
    name: "gotenberg.render",
    description:
      "Render HTML into a PDF using Gotenberg (for invoices, branded documents, anything needing exact layout). Params: html (required, a full HTML document), filename (default document.pdf). The PDF flows to the next node as binary data — chain telegram.send to deliver it.",
    inputSchema: {
      type: "object",
      required: ["html"],
      properties: {
        html: { type: "string" },
        filename: { type: "string" },
      },
    },
    run: async (params) => {
      const base = opts.baseUrl ?? process.env.GOTENBERG_URL ?? "http://127.0.0.1:3000";
      const form = new FormData();
      // Gotenberg renders index.html and nothing else — the name is the API.
      form.append("files", new Blob([String(params.html)], { type: "text/html" }), "index.html");

      const res = await fetch(`${base}/forms/chromium/convert/html`, { method: "POST", body: form });
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 300);
        throw new Error(`gotenberg.render: HTTP ${res.status} — ${detail}`);
      }

      const pdf = Buffer.from(await res.arrayBuffer());
      if (!pdf.subarray(0, 5).toString().startsWith("%PDF")) {
        throw new Error("gotenberg.render: response was not a PDF — check the Gotenberg service");
      }

      const filename = String(params.filename ?? "document.pdf");
      return [{ json: { filename, bytes: pdf.length, kind: "pdf" }, binary: { data: pdf } }];
    },
  };
}
