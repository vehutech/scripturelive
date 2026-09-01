/**
 * Index and tracking, off the main thread.
 *
 * Building the KJV index means tokenizing 31,102 verses, which would block the interface
 * for long enough to be visible. It happens here instead, and because the tracker needs
 * two searches per utterance, it lives here too — one message per frame rather than four.
 */

import { loadCorpus, normalizeFor, type CorpusName } from "./corpus";
import { Index } from "./matcher";
import { Tracker, type TrackResult } from "./tracker";

export type SearchReason = "manual" | "alternatives";

export type ToWorker =
  | { type: "load"; corpus: CorpusName }
  | { type: "feed"; text: string }
  | { type: "reset" }
  /** Rank the whole corpus without touching the tracked position — for typed search.
   *  `reason` comes back on the response so the caller knows which request it answers. */
  | { type: "search"; text: string; topK?: number; reason: SearchReason };

export type FromWorker =
  | { type: "progress"; detail: string }
  | { type: "ready"; corpus: CorpusName; verseCount: number; termCount: number; ms: number }
  | { type: "result"; result: TrackResult | null }
  | {
      type: "hits";
      reason: SearchReason;
      hits: { ref: string; id: number; text: string; score: number }[];
    }
  | { type: "failed"; message: string };

let corpus: CorpusName = "kjv";
let index: Index | null = null;
let tracker: Tracker | null = null;

const post = (message: FromWorker) => self.postMessage(message);

self.onmessage = async (event: MessageEvent<ToWorker>) => {
  const message = event.data;
  try {
    switch (message.type) {
      case "load": {
        const started = performance.now();
        corpus = message.corpus;
        post({ type: "progress", detail: "Downloading the text" });
        const verses = await loadCorpus(corpus);
        post({ type: "progress", detail: `Indexing ${verses.length.toLocaleString()} verses` });
        index = new Index(verses);
        tracker = new Tracker(index);
        post({
          type: "ready",
          corpus,
          verseCount: verses.length,
          termCount: index.termCount,
          ms: Math.round(performance.now() - started),
        });
        return;
      }

      case "feed": {
        if (!tracker) return post({ type: "failed", message: "The index is not ready yet." });
        post({ type: "result", result: tracker.feed(normalizeFor(corpus, message.text)) });
        return;
      }

      case "reset": {
        tracker?.reset();
        return;
      }

      case "search": {
        if (!index) return post({ type: "failed", message: "The index is not ready yet." });
        const hits = index
          .search(normalizeFor(corpus, message.text), { topK: message.topK ?? 5 })
          .map(({ verse, score }) => ({
            ref: verse.ref,
            id: verse.id,
            text: verse.text,
            score,
          }));
        post({ type: "hits", reason: message.reason, hits });
        return;
      }
    }
  } catch (error) {
    post({
      type: "failed",
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
