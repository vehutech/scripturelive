/**
 * Text normalization.
 *
 * These must stay byte-identical to the Python ones in eval/corpus.py. The evaluation
 * harness measures the matcher through those; if the two drift, every number the harness
 * reports stops describing what ships.
 *
 * Every Arabic codepoint below is written as an escape rather than a literal, and that is
 * deliberate. Written literally, the strip class had two characters silently transposed by
 * bidi reordering into a range covering U+0610 to U+064B - the entire Arabic alphabet.
 * The normalizer returned an empty string for every Arabic input, and it looked correct on
 * screen. Escapes cannot be reordered, and normalizeArabic is now asserted against the
 * Python fixtures so a regression here fails the build.
 */

/**
 * Marks that carry no information for matching and that recognition never emits:
 * Arabic signs (U+0610-U+061A), harakat (U+064B-U+065F), superscript alif
 * (U+0670), Quranic annotation (U+06D6-U+06ED), and tatweel (U+0640).
 */
const ARABIC_STRIP = /[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g;

/** Byte-order mark and zero-width joiners. */
const INVISIBLE = /[\uFEFF\u200C\u200D]/g;

/**
 * Alef variants fold to bare alef, alef maksura to yeh, teh marbuta to heh - the
 * distinctions recognition does not reliably produce.
 */
const ARABIC_FOLD: Record<string, string> = {
  "\u0622": "\u0627", // alef with madda
  "\u0623": "\u0627", // alef with hamza above
  "\u0625": "\u0627", // alef with hamza below
  "\u0671": "\u0627", // alef wasla
  "\u0649": "\u064A", // alef maksura -> yeh
  "\u0629": "\u0647", // teh marbuta -> heh
};

const ARABIC_FOLD_RE = /[\u0622\u0623\u0625\u0671\u0649\u0629]/g;

/** Fold Arabic to the orthography-insensitive form used for matching. */
export function normalizeArabic(text: string): string {
  return text
    .normalize("NFC")
    .replace(INVISIBLE, "")
    .replace(ARABIC_STRIP, "")
    .replace(ARABIC_FOLD_RE, (char) => ARABIC_FOLD[char] ?? char)
    .replace(/\s+/g, " ")
    .trim();
}

/** Fold English to the form recognition output arrives in: lowercase, unpunctuated. */
export function normalizeEnglish(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
