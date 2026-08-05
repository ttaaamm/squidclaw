/**
 * Chat platforms cap how long a single message can be (Telegram: 4096
 * chars) and reject anything over it outright — the whole reply is lost,
 * not just trimmed. Split long text into several messages instead, at a
 * paragraph or line boundary where one exists nearby so a sentence doesn't
 * get sliced mid-word.
 */
export function chunkMessage(text: string, limit = 4000): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let cut = rest.lastIndexOf("\n\n", limit);
    if (cut < limit * 0.5) cut = rest.lastIndexOf("\n", limit);
    if (cut < limit * 0.5) cut = limit;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}
