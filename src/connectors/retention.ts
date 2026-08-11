/**
 * The default retention boundary for copyright-protected source text.
 * Titles and factual metadata are separate; excerpts retain at most 25 words.
 */
export function retainExcerpt(value: string | undefined, maximumWords = 25): string {
  const normalized = (value ?? "").replace(/\s+/gu, " ").trim();
  if (!normalized) return "";
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  let words = 0;
  let excerpt = "";
  for (const segment of segmenter.segment(normalized)) {
    if (segment.isWordLike) {
      if (words >= maximumWords) break;
      words += 1;
    }
    excerpt += segment.segment;
  }
  return excerpt.trim().slice(0, 2_000);
}
