/**
 * Text normalization.
 *
 * These must stay byte-identical to the Python ones in eval/corpus.py. The evaluation
 * harness measures the matcher through those; if the two drift, every number the harness
 * reports stops describing what ships. `npm test` asserts they agree across all 37,338
 * verses, so a change here that is not mirrored there fails the build.
 */

// Harakat, Quranic annotation signs, superscript alif, and tatweel all carry no
// information for matching, and recognition never emits them.
const ARABIC_STRIP = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

const ARABIC_FOLD: Record<string, string> = {
  "آ": "ا", // آ -> ا
  "أ": "ا", // أ -> ا
  "إ": "ا", // إ -> ا
  "ٱ": "ا", // ٱ -> ا
  "ى": "ي", // ى -> ي
  "ة": "ه", // ة -> ه
};

const ARABIC_FOLD_RE = new RegExp(`[${Object.keys(ARABIC_FOLD).join("")}]`, "g");

/** Fold Arabic to the orthography-insensitive form used for matching. */
export function normalizeArabic(text: string): string {
  return text
    .normalize("NFC")
    .replace(/[﻿‌‍]/g, "")
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
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
