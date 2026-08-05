/**
 * True vector memory — meaning, not just words. Local, no API: an embedding
 * server (llama.cpp, same family as the whisper.cpp ears) turns text into a
 * point in space; two texts that MEAN the same thing land close together
 * even with zero shared vocabulary ("reach my box" ↔ "SSH access works").
 *
 * The wire format follows the OpenAI-compatible /v1/embeddings shape llama
 * -server exposes — parsed defensively, because that contract has drifted
 * across versions and a stumble here must never mean the agent forgets.
 */

export type Embedder = (text: string) => Promise<number[]>;

export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom ? dot / denom : 0;
}

export function embedViaServer(url: string): Embedder {
  return async (text: string): Promise<number[]> => {
    const res = await fetch(`${url}/v1/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`embed: HTTP ${res.status}`);
    const body = (await res.json()) as unknown;
    const vec =
      (body as { data?: Array<{ embedding?: number[] }> })?.data?.[0]?.embedding ??
      (body as { embedding?: number[] })?.embedding ??
      (Array.isArray(body) ? (body[0] as { embedding?: number[] })?.embedding : undefined);
    if (!Array.isArray(vec) || !vec.length) throw new Error("embed: unrecognized response shape");
    return vec;
  };
}
