/**
 * Position tracking: acquire once, then follow.
 *
 * Ports the state machine measured in eval/evaluate.py. The unlock is the part that
 * matters: a windowed search always returns something, so without an explicit way out a
 * single bad initial lock is permanent. Phase 0 measured that failure as zero in-book
 * matches against a 5.7% word-error transcript, and adding the unlock took it to 95.2%.
 */

import type { Verse } from "./corpus";
import type { Index } from "./matcher";

/** A global hit must beat the tracked window by this ratio to count against the lock. */
const JUMP_MARGIN = 1.35;
/** ...and must do so this many frames running before the position actually moves. */
const UNLOCK_AFTER = 2;
/** Below this BM25 score a frame is noise and must not be allowed to establish a lock. */
const LOCK_FLOOR = 12;
/** Fewer terms than this carries too little signal to act on. */
const MIN_TERMS = 3;

export interface TrackResult {
  verse: Verse;
  score: number;
  /**
   * How much the top hit beat the runner-up, 0–1. Margin rather than absolute score,
   * because what matters is whether anything else could plausibly be the answer.
   */
  confidence: number;
  /**
   * True when the runner-up has identical text — the words are right but the reference
   * is not decidable from text alone. Ar-Rahman's refrain occurs 31 times; "and the LORD
   * spake unto Moses saying" 72 times.
   */
  ambiguousReference: boolean;
  /** Whether this came from the tracked window rather than a whole-corpus search. */
  tracked: boolean;
  /** Whether the position jumped elsewhere on this frame. */
  jumped: boolean;
}

export class Tracker {
  private index: Index;
  private currentPosition: number | null = null;
  private consecutiveBetter = 0;

  constructor(index: Index) {
    this.index = index;
  }

  get position(): number | null {
    return this.currentPosition;
  }

  reset(): void {
    this.currentPosition = null;
    this.consecutiveBetter = 0;
  }

  /**
   * Feed one recognized utterance. Returns the chosen verse, or null when the frame
   * carried too little signal to act on — which is a normal outcome, not an error.
   */
  feed(query: string): TrackResult | null {
    const terms = query.length ? query.split(" ") : [];
    if (terms.length < MIN_TERMS) return null;

    const globalHits = this.index.search(query, { topK: 2 });
    const windowHits =
      this.currentPosition === null
        ? []
        : this.index.search(query, { topK: 2, near: this.currentPosition });

    if (globalHits.length === 0 && windowHits.length === 0) return null;

    // No lock yet: only a confident global hit may establish one.
    if (windowHits.length === 0) {
      const best = globalHits[0];
      if (best === undefined || best.score < LOCK_FLOOR) return null;
      this.currentPosition = best.verse.id;
      return this.describe(best.verse, best.score, globalHits, false, false);
    }

    const windowBest = windowHits[0]!;
    const globalBest = globalHits[0];
    const globalScore = globalBest?.score ?? 0;

    if (globalScore > windowBest.score * JUMP_MARGIN) this.consecutiveBetter++;
    else this.consecutiveBetter = 0;

    if (this.consecutiveBetter >= UNLOCK_AFTER && globalBest !== undefined) {
      this.consecutiveBetter = 0;
      this.currentPosition = globalBest.verse.id;
      return this.describe(globalBest.verse, globalBest.score, globalHits, false, true);
    }

    this.currentPosition = windowBest.verse.id;
    return this.describe(windowBest.verse, windowBest.score, windowHits, true, false);
  }

  private describe(
    verse: Verse,
    score: number,
    hits: { verse: Verse; score: number }[],
    tracked: boolean,
    jumped: boolean,
  ): TrackResult {
    const runnerUp = hits[1];
    const confidence =
      runnerUp === undefined || score <= 0
        ? 1
        : Math.max(0, Math.min(1, 1 - runnerUp.score / score));
    return {
      verse,
      score,
      confidence,
      ambiguousReference:
        runnerUp !== undefined && runnerUp.verse.matchText === verse.matchText,
      tracked,
      jumped,
    };
  }
}
