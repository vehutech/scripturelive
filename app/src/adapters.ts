/**
 * One adapter per corpus.
 *
 * The Bible and the Quran are both ordered collections of numbered units, so they share
 * one engine — one index, one matcher, one tracker, none of which know which corpus they
 * hold. But they are not the same kind of thing, and the differences are the sort that
 * turn into bugs when flattened into conditionals scattered across files:
 *
 *   - the KJV's canonical text is the translation; the Quran's is the Arabic, and the
 *     translation is secondary
 *   - one reads left to right, the other right to left
 *   - one is read, the other recited
 *   - a KJV reference names its book, an ayah reference is two numbers
 *   - normalizing the KJV's display text reproduces its matching text; the Quran's does
 *     not, because its display text is Uthmani while matching runs on the simple edition
 *
 * Everything corpus-specific belongs here, so adding a third corpus means adding an
 * adapter rather than hunting for ternaries.
 */

import { normalizeArabic, normalizeEnglish } from "./normalize";

export type CorpusName = "kjv" | "quran";

export interface CorpusAdapter {
  readonly name: CorpusName;
  /** Shown in the corpus picker. */
  readonly label: string;
  /** Writing direction for the verse text. */
  readonly direction: "ltr" | "rtl";
  /** BCP-47 tag for the recognition engines. */
  readonly recognitionLanguage: string;
  /** Fold display or recognized text into the form the index holds. */
  normalize(text: string): string;
  /** Build a human reference from a book name and its numbers. */
  formatRef(book: string, chapter: number, verse: number): string;
  /**
   * Whether a secondary translation ships alongside the canonical text.
   *
   * The KJV has none, and that is the point rather than an omission: for an English
   * reader the translation *is* the text. The Quran's canonical text is the Arabic, so a
   * translation is a second thing shown beside it, never in place of it.
   */
  readonly hasTranslation: boolean;
}

const KJV: CorpusAdapter = {
  name: "kjv",
  label: "Bible — KJV",
  direction: "ltr",
  recognitionLanguage: "en",
  normalize: normalizeEnglish,
  formatRef: (book, chapter, verse) => `${book} ${chapter}:${verse}`,
  hasTranslation: false,
};

const QURAN: CorpusAdapter = {
  name: "quran",
  label: "Quran — Uthmani",
  direction: "rtl",
  recognitionLanguage: "ar",
  normalize: normalizeArabic,
  // A surah is addressed by number, so the book name carries no extra information.
  formatRef: (_book, chapter, verse) => `${chapter}:${verse}`,
  hasTranslation: true,
};

export const ADAPTERS: Record<CorpusName, CorpusAdapter> = { kjv: KJV, quran: QURAN };

export const CORPORA: CorpusAdapter[] = [KJV, QURAN];

export function adapterFor(name: CorpusName): CorpusAdapter {
  return ADAPTERS[name];
}
