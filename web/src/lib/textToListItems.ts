/** Caps how many lines a single upload can add to one field — well above any reasonable guidance
 *  document, but a hard ceiling so a huge/malformed file can't silently balloon the manifest (see
 *  MAX_PROJECT_CONTEXT_MANIFEST_BYTES on the backend, which the eventual Save is still subject to). */
const MAX_ITEMS_PER_UPLOAD = 200;

/**
 * Turns raw extracted document text (from fileTextExtractor.ts) into a flat list of guidance lines
 * suitable for one of Project Context's string-array fields (instructions/architecture/
 * conventions/validation guidance/constraints). Deliberately simple — one line of prose per list
 * item, not a markdown-aware outline: strips common bullet/numbering prefixes and blank lines, but
 * never rewrites or summarizes the author's own wording.
 */
export function textToListItems(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, "").replace(/^#+\s*/, "").trim())
    .filter((line) => line.length > 0)
    .slice(0, MAX_ITEMS_PER_UPLOAD);
}
