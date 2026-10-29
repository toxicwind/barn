/**
 * tldr.ts — extractive TL;DR helper.
 *
 * First-sentence + keyword-density compression. Never invents content.
 */
/** Extractive TL;DR: first-sentence + keyword-density compression. Never invents. */
export function tldrExtractive(
  abstract: string,
  title: string | null = null,
  maxChars = 320,
): string {
  if (!abstract.trim()) return title ?? "";
  const sentences = abstract.match(/[^.!?]+[.!?]*/g) ?? [abstract];
  const words = new Set(
    (title ?? "")
      .toLowerCase()
      .split(/\W+/)
      .filter((w) => w.length > 3),
  );
  let best = sentences[0] ?? "";
  let bestScore = -1;
  for (const sentence of sentences.slice(0, 6)) {
    const score = sentence
      .split(/\W+/)
      .filter((w) => words.has(w.toLowerCase())).length;
    if (score > bestScore) {
      bestScore = score;
      best = sentence;
    }
  }
  const text = best.trim().replace(/\s+/g, " ");
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
}
