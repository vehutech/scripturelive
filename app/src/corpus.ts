/**
 * Corpus loading and text normalization.
 *
 * These normalizers must stay byte-identical to the Python ones in eval/corpus.py.
 * The evaluation harness measures the matcher through those; if the two drift, every
 * number the harness reports stops describing what ships. `npm test` asserts they agree
 * across all 37,338 verses.
 */

export type CorpusName = "kjv" | "quran";

export interface Verse {
  /** 0-based ordinal in canonical order — the id the matcher and tracker pass around. */
  id: number;
  ref: string;
  book: string;
  chapter: number;
  verse: number;
  /** As published, for display. */
  text: string;
  /** Normalized, for matching. */
  matchText: string;
}

interface Structure {
  books: { name: string; chapters: number[] }[];
  /**
   * Whether matching text ships as a separate file rather than being derived from the
   * display text. True for the Quran, whose display text is Uthmani while matching runs
   * against the simple edition; the two differ orthographically — الصلوة against الصلاة,
   * superscript alif against a written one — in ways no folding reconciles. False for the
   * KJV, where normalizing the display text reproduces the matching text exactly.
   */
  hasMatchFile?: boolean;
}

// Harakat, Quranic annotation signs, superscript alif, and tatweel all carry no
// information for matching, and recognition never emits them.
const ARABIC_STRIP = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;

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

export function normalizeFor(corpus: CorpusName, text: string): string {
  return corpus === "quran" ? normalizeArabic(text) : normalizeEnglish(text);
}

/**
 * Rebuild the full verse list from the two shipped files.
 *
 * The text file is one verse per line in canonical order; the structure file names each
 * book and how many verses each of its chapters holds. Everything else — ids, references
 * — follows from walking the two together.
 */
export function parseCorpus(
  name: CorpusName,
  text: string,
  structure: Structure,
  matchText?: string,
): Verse[] {
  const lines = text.split("\n");
  const matchLines = matchText === undefined ? null : matchText.split("\n");
  if (matchLines && matchLines.length !== lines.length) {
    throw new Error(
      `${name}: ${lines.length} verses but ${matchLines.length} lines of matching text`,
    );
  }
  const verses: Verse[] = [];

  for (const book of structure.books) {
    for (const [chapterIndex, count] of book.chapters.entries()) {
      for (let verseNo = 1; verseNo <= count; verseNo++) {
        const chapter = chapterIndex + 1;
        const line = lines[verses.length];
        if (line === undefined) {
          throw new Error(
            `${name}: structure expects a verse at line ${verses.length} but the text ends`,
          );
        }
        verses.push({
          id: verses.length,
          ref: name === "kjv" ? `${book.name} ${chapter}:${verseNo}` : `${chapter}:${verseNo}`,
          book: book.name,
          chapter,
          verse: verseNo,
          text: line,
          matchText: matchLines?.[verses.length] ?? normalizeFor(name, line),
        });
      }
    }
  }

  if (verses.length !== lines.length) {
    throw new Error(
      `${name}: structure describes ${verses.length} verses but the text has ${lines.length}`,
    );
  }
  return verses;
}

async function get(url: string): Promise<string> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`could not load ${url} (${response.status})`);
  return response.text();
}

/** Fetch and parse a corpus. `base` lets a worker resolve against its own origin. */
export async function loadCorpus(name: CorpusName, base = "/data"): Promise<Verse[]> {
  const [text, structureJson] = await Promise.all([
    get(`${base}/${name}.txt`),
    get(`${base}/${name}.idx.json`),
  ]);
  const structure = JSON.parse(structureJson) as Structure;
  const matchText = structure.hasMatchFile
    ? await get(`${base}/${name}.match.txt`)
    : undefined;
  return parseCorpus(name, text, structure, matchText);
}
