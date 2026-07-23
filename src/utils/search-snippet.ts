/**
 * In-book search helpers shared by the Worker (snippet building) and the
 * reader (match highlighting). Pure string functions, no dependencies.
 */

/** Escape %, _ and \ so user input is matched literally inside a LIKE pattern
 *  (callers must pass ESCAPE '\' alongside). */
export function escapeLikePattern(query: string): string {
  return query.replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * Build a short excerpt around the first case-insensitive occurrence of
 * `query` in `text`, or null when the text doesn't contain it.
 * `radius` is how many characters of context to keep on each side.
 */
export function buildSnippet(
  text: string,
  query: string,
  radius = 40
): string | null {
  if (!query) return null;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx === -1) return null;

  const start = Math.max(0, idx - radius);
  const end = Math.min(text.length, idx + query.length + radius);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return prefix + text.slice(start, end) + suffix;
}
