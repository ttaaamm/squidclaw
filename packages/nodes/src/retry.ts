/**
 * Retry policy for outbound sends, OpenClaw-style: retry the current HTTP
 * request only (never a multi-step flow), honor the provider's retry_after,
 * back off with jitter, and refuse to sleep through absurd rate limits —
 * a minute-long 429 should surface, not silently stall a conversation.
 */

export interface RetryOptions {
  attempts?: number;
  minDelayMs?: number;
  maxDelayMs?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function fetchWithRetry(
  url: string,
  init?: RequestInit,
  opts: RetryOptions = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  const min = opts.minDelayMs ?? 400;
  const max = opts.maxDelayMs ?? 8_000;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const res = await fetch(url, init);
      const transient = res.status === 429 || res.status >= 500;
      if (!transient || attempt === attempts) return res;

      let wait = Math.min(max, min * 2 ** (attempt - 1));
      // Telegram sends retry_after (seconds) in the error body; peek without consuming.
      try {
        const body = (await res.clone().json()) as { parameters?: { retry_after?: number } };
        const after = body?.parameters?.retry_after;
        if (typeof after === "number") wait = Math.max(wait, after * 1000);
      } catch { /* not JSON — keep the backoff */ }
      if (wait > 30_000) return res; // too long to hide — let the caller see the 429

      await sleep(wait + Math.random() * wait * 0.1);
    } catch (err) {
      lastErr = err;
      if (attempt === attempts) throw err;
      await sleep(Math.min(max, min * 2 ** (attempt - 1)));
    }
  }
  throw lastErr; // unreachable, but the types deserve honesty
}
