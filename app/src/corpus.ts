/**
 * Corpus loading.
 *
 * Corpora ship as one verse per line plus a small structure file naming each book and its
 * per-chapter verse counts. Ids and references follow from walking the two together, so
 * neither is stored — the KJV is 4.1 MB, 1.21 MB gzipped, rather than the 11.7 MB the
 * evaluation JSON costs.
 *
 * Nothing here knows which corpus it holds; everything corpus-specific comes from the
 * adapter.
 */

import { adapterFor, type CorpusAdapter, type CorpusName } from "./adapters";

export type { CorpusName, CorpusAdapter };

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
  /** Secondary translation, where the corpus ships one. */
  translation?: string;
}

interface Structure {
  books: { name: string; chapters: number[] }[];
  /**
   * Whether matching text ships as its own file rather than being derived from the
   * display text. True for the Quran, whose display text is Uthmani while matching runs
   * against the simple edition; the two differ orthographically — الصلوة against الصلاة,
   * superscript alif against a written one — in ways no folding reconciles. False for the
   * KJV, where normalizing the display text reproduces the matching text exactly.
   */
  hasMatchFile?: boolean;
  /** Attribution for the shipped translation, shown to the reader. Absent when none. */
  translation?: string;
}

/** Rebuild the full verse list from the two shipped files. */
export function parseCorpus(
  name: CorpusName,
  text: string,
  structure: Structure,
  matchText?: string,
  translationText?: string,
): Verse[] {
  const adapter = adapterFor(name);
  const lines = text.split("\n");
  const matchLines = matchText === undefined ? null : matchText.split("\n");
  const translationLines =
    translationText === undefined ? null : translationText.split("\n");
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
        const translation = translationLines?.[verses.length];
        verses.push({
          id: verses.length,
          ref: adapter.formatRef(book.name, chapter, verseNo),
          book: book.name,
          chapter,
          verse: verseNo,
          text: line,
          matchText: matchLines?.[verses.length] ?? adapter.normalize(line),
          ...(translation ? { translation } : {}),
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
  const [matchText, translationText] = await Promise.all([
    structure.hasMatchFile ? get(`${base}/${name}.match.txt`) : undefined,
    structure.translation ? get(`${base}/${name}.translation.txt`) : undefined,
  ]);
  return parseCorpus(name, text, structure, matchText, translationText);
}

/** Attribution for a corpus's translation, or null when it ships none. */
export async function translationLabel(
  name: CorpusName,
  base = "/data",
): Promise<string | null> {
  const structure = JSON.parse(await get(`${base}/${name}.idx.json`)) as Structure;
  return structure.translation ?? null;
}
