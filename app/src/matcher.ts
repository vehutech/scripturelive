/**
 * BM25 verse matching over an inverted index.
 *
 * A direct port of eval/matcher.py — same constants, same candidate selection, same
 * tie-breaking — so the numbers the evaluation harness reports describe this code.
 *
 * Two modes, mirroring the product's own:
 *
 *     search(query)                 acquire — rank the whole corpus
 *     search(query, { near })       track   — rank only a window around a known position
 */

import type { Verse } from "./corpus";

const K1 = 1.5; // term-frequency saturation
const B = 0.75; // length normalization

// Candidates come from the rarest query terms only. Common words appear in most of the
// corpus and contribute almost nothing to the score, so pulling their postings costs
// time without changing the ranking.
const RAREST_TERMS = 8;

/** How far around the current position a tracked search looks. */
export const WINDOW_BACK = 2;
export const WINDOW_FORWARD = 10;

export interface Hit {
  verse: Verse;
  score: number;
}

export interface SearchOptions {
  topK?: number;
  /** Verse id to search around. Omit for a whole-corpus search. */
  near?: number | undefined;
}

export class Index {
  readonly verses: Verse[];
  /** term -> flat [id, count, id, count, ...] */
  private readonly postings = new Map<string, number[]>();
  private readonly idf = new Map<string, number>();
  private readonly lengths: Int32Array;
  private readonly averageLength: number;

  constructor(verses: Verse[]) {
    this.verses = verses;
    this.lengths = new Int32Array(verses.length);

    const counts = new Map<string, number>();
    for (const verse of verses) {
      const terms = verse.matchText.length ? verse.matchText.split(" ") : [];
      this.lengths[verse.id] = terms.length;

      counts.clear();
      for (const term of terms) counts.set(term, (counts.get(term) ?? 0) + 1);
      for (const [term, count] of counts) {
        let posting = this.postings.get(term);
        if (posting === undefined) {
          posting = [];
          this.postings.set(term, posting);
        }
        posting.push(verse.id, count);
      }
    }

    let total = 0;
    for (const length of this.lengths) total += length;
    this.averageLength = total / verses.length;

    for (const [term, posting] of this.postings) {
      const documentFrequency = posting.length / 2;
      this.idf.set(
        term,
        Math.log(
          1 + (verses.length - documentFrequency + 0.5) / (documentFrequency + 0.5),
        ),
      );
    }
  }

  get termCount(): number {
    return this.postings.size;
  }

  private candidates(terms: string[]): Set<number> {
    const known = [...new Set(terms)].filter((term) => this.postings.has(term));
    known.sort((a, b) => (this.idf.get(b) ?? 0) - (this.idf.get(a) ?? 0));

    const candidates = new Set<number>();
    for (const term of known.slice(0, RAREST_TERMS)) {
      const posting = this.postings.get(term)!;
      for (let i = 0; i < posting.length; i += 2) candidates.add(posting[i]!);
    }
    return candidates;
  }

  search(query: string, options: SearchOptions = {}): Hit[] {
    const { topK = 5, near } = options;
    const terms = query.length ? query.split(" ") : [];
    if (terms.length === 0) return [];

    const candidates =
      near === undefined
        ? this.candidates(terms)
        : windowIds(near, this.verses.length);

    const scores = new Map<number, number>();
    for (const term of terms) {
      const posting = this.postings.get(term);
      if (posting === undefined) continue;
      const idf = this.idf.get(term)!;
      for (let i = 0; i < posting.length; i += 2) {
        const id = posting[i]!;
        if (!candidates.has(id)) continue;
        const count = posting[i + 1]!;
        const norm = 1 - B + (B * this.lengths[id]!) / this.averageLength;
        scores.set(
          id,
          (scores.get(id) ?? 0) + (idf * count * (K1 + 1)) / (count + K1 * norm),
        );
      }
    }

    // Ties broken by id so the ranking is deterministic and matches the Python harness.
    return [...scores.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, topK)
      .map(([id, score]) => ({ verse: this.verses[id]!, score }));
  }
}

function windowIds(near: number, corpusSize: number): Set<number> {
  const low = Math.max(0, near - WINDOW_BACK);
  const high = Math.min(corpusSize, near + WINDOW_FORWARD + 1);
  const ids = new Set<number>();
  for (let id = low; id < high; id++) ids.add(id);
  return ids;
}
