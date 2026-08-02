import type { NodeDef } from "@squidclaw/kernel";

export const httpRequestNode: NodeDef = {
  name: "http.request",
  description:
    "Makes an HTTP request. Params: url (required), method (GET|POST, default GET), body (JSON for POST). Returns {status, body}.",
  inputSchema: {
    type: "object",
    required: ["url"],
    properties: {
      url: { type: "string" },
      method: { type: "string", enum: ["GET", "POST"] },
      body: {},
    },
  },
  run: async (params) => {
    const method = (params.method as string) ?? "GET";
    const res = await fetch(params.url as string, {
      method,
      headers: params.body ? { "content-type": "application/json" } : undefined,
      body: params.body ? JSON.stringify(params.body) : undefined,
    });
    const text = await res.text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // not JSON — keep the raw text
    }
    return [{ json: { status: res.status, body } }];
  },
};
