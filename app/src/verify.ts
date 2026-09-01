/**
 * Cross-language verification: prove this port behaves exactly like the Python harness.
 *
 * The evaluation harness in eval/ measures the Python matcher, but the browser runs this
 * one. Unless the two agree exactly, the harness numbers stop describing what ships. This
 * checks agreement on the whole corpus, not a sample.
 *
 *     npm test
 */

import { createHash } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { parseCorpus, normalizeEnglish, type CorpusName, type Verse } from "./corpus";
import { Index } from "./matcher";
import { Tracker } from "./tracker";
import fixtures from "./fixtures.json" with { type: "json" };

const here = dirname(fileURLToPath(import.meta.url));
const DATA = join(here, "..", "public", "data");
const TRANSCRIPT = join(
  here,
  "..",
  "..",
  "eval",
  "data",
  "transcript_ephesians_kjv_whisper-base.json",
);

let failures = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    console.log(`  ok    ${label}`);
  } else {
    failures++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Same construction as eval/emit_fixtures.py: each value's bytes, then a NUL. */
function digest(values: string[]): string {
  const sha = createHash("sha256");
  for (const value of values) {
    sha.update(Buffer.from(value, "utf-8"));
    sha.update(Buffer.from([0]));
  }
  return sha.digest("hex");
}

function loadLocal(name: CorpusName): Verse[] {
  const structure = JSON.parse(readFileSync(join(DATA, `${name}.idx.json`), "utf-8"));
  const matchPath = join(DATA, `${name}.match.txt`);
  return parseCorpus(
    name,
    readFileSync(join(DATA, `${name}.txt`), "utf-8"),
    structure,
    structure.hasMatchFile ? readFileSync(matchPath, "utf-8") : undefined,
  );
}

function verifyCorpus(name: CorpusName): Index {
  const expected = fixtures.corpora[name];
  console.log(`\n${name}`);

  const verses = loadLocal(name);
  check(
    `${expected.verseCount.toLocaleString()} verses parsed`,
    verses.length === expected.verseCount,
    `got ${verses.length}`,
  );
  check(
    "references reconstruct identically",
    digest(verses.map((v) => v.ref)) === expected.refDigest,
  );
  check(
    "normalizer agrees across every verse",
    digest(verses.map((v) => v.matchText)) === expected.matchTextDigest,
  );

  const index = new Index(verses);
  check(
    `${expected.termCount.toLocaleString()} distinct terms indexed`,
    index.termCount === expected.termCount,
    `got ${index.termCount}`,
  );

  let searchMismatches = 0;
  for (const item of expected.searches) {
    const hits = index.search(item.normalized, { topK: 5 });
    const sameOrder =
      hits.length === item.hits.length &&
      hits.every((hit, i) => hit.verse.ref === item.hits[i]!.ref);
    const sameScores = hits.every(
      (hit, i) => Math.abs(hit.score - item.hits[i]!.score) < 1e-6,
    );
    if (!sameOrder || !sameScores) {
      searchMismatches++;
      console.log(
        `        ${item.query}\n` +
          `          python: ${item.hits.map((h) => `${h.ref}@${h.score.toFixed(2)}`).join(", ")}\n` +
          `          ts:     ${hits.map((h) => `${h.verse.ref}@${h.score.toFixed(2)}`).join(", ")}`,
      );
    }
  }
  check(
    `${expected.searches.length} acquire searches rank identically`,
    searchMismatches === 0,
    `${searchMismatches} differed`,
  );

  let trackedMismatches = 0;
  for (const item of expected.tracked) {
    const hits = index.search(item.normalized, { topK: 5, near: item.nearId });
    const same =
      hits.length === item.hits.length &&
      hits.every(
        (hit, i) =>
          hit.verse.ref === item.hits[i]!.ref &&
          Math.abs(hit.score - item.hits[i]!.score) < 1e-6,
      );
    if (!same) trackedMismatches++;
  }
  check(
    `${expected.tracked.length} tracked searches rank identically`,
    trackedMismatches === 0,
  );

  return index;
}

/**
 * Replay the Phase 0 Spike A transcript through the tracker.
 *
 * This is the strongest available check: the same recognized segments that produced the
 * measured 95.2% in-book rate, run through the shipping implementation.
 */
function verifyTracking(index: Index): void {
  console.log("\ntracking — Phase 0 Spike A replay");
  if (!existsSync(TRANSCRIPT)) {
    console.log("  skip  cached transcript absent (run: python3 eval/evaluate.py --spike A)");
    return;
  }

  const { segments } = JSON.parse(readFileSync(TRANSCRIPT, "utf-8")) as {
    segments: string[];
  };
  const span = new Set(
    index.verses.filter((v) => v.book === "Ephesians").map((v) => v.id),
  );

  const tracker = new Tracker(index);
  const chosen: number[] = [];
  const confidences: { id: number; confidence: number }[] = [];
  for (const segment of segments) {
    const result = tracker.feed(normalizeEnglish(segment));
    if (result) {
      chosen.push(result.verse.id);
      confidences.push({ id: result.verse.id, confidence: result.confidence });
    }
  }

  const inSpan = chosen.filter((id) => span.has(id)).length / chosen.length;
  const inOrder =
    chosen.slice(1).filter((id, i) => id >= chosen[i]!).length / (chosen.length - 1);
  const reached = new Set(chosen.filter((id) => span.has(id))).size;

  console.log(
    `        ${segments.length} segments, ${chosen.length} matched, ` +
      `${reached}/${span.size} verses reached`,
  );
  check(
    `in-book rate ${(inSpan * 100).toFixed(1)}% (Python measured 95.2%)`,
    inSpan >= 0.9,
  );
  check(
    `in-order rate ${(inOrder * 100).toFixed(1)}% (Python measured 98.9%)`,
    inOrder >= 0.95,
  );

  // The Phase 1 gate: precision on the matches the UI would actually present as
  // confident. Low-confidence frames are meant to be shown as uncertain, so they do not
  // count against precision — but they must not be silently dropped either, so the
  // retained share is reported alongside.
  console.log("\n        precision by confidence threshold:");
  let gateMet = false;
  for (const threshold of [0, 0.1, 0.25, 0.5]) {
    const kept = confidences.filter((c) => c.confidence >= threshold);
    if (kept.length === 0) continue;
    const precision = kept.filter((c) => span.has(c.id)).length / kept.length;
    const retained = kept.length / confidences.length;
    console.log(
      `          >= ${threshold.toFixed(2)}   precision ${(precision * 100).toFixed(1)}%` +
        `   retained ${(retained * 100).toFixed(1)}% of frames`,
    );
    if (threshold >= 0.25 && precision >= 0.95 && retained >= 0.5) gateMet = true;
  }
  check("Phase 1 gate — precision above 95% on high-confidence matches", gateMet);
}

/** Behaviour the tracker must have regardless of corpus, per the Phase 0 findings. */
function verifyTrackerBehaviour(index: Index): void {
  console.log("\ntracker behaviour");

  const psalm23 = index.verses.find((v) => v.ref === "Psalms 23:1")!;
  const tracker = new Tracker(index);

  const first = tracker.feed(normalizeEnglish("The LORD is my shepherd I shall not want"));
  check("acquires a lock from a confident global hit", first?.verse.ref === "Psalms 23:1");
  check("position follows the lock", tracker.position === psalm23.id);

  const second = tracker.feed(
    normalizeEnglish("He maketh me to lie down in green pastures"),
  );
  check("advances inside the window", second?.verse.ref === "Psalms 23:2");
  check("reports the advance as tracked", second?.tracked === true);

  // A decisive jump elsewhere must take two consecutive frames to move the position.
  const johnText = normalizeEnglish(
    "For God so loved the world that he gave his only begotten Son",
  );
  const jump1 = tracker.feed(johnText);
  check("a single strong outside hit does not unlock", jump1?.verse.ref !== "John 3:16");
  const jump2 = tracker.feed(johnText);
  check("two consecutive strong outside hits do unlock", jump2?.verse.ref === "John 3:16");
  check("the unlock is reported", jump2?.jumped === true);

  tracker.reset();
  check("reset clears the position", tracker.position === null);
  check("noise cannot establish a lock", tracker.feed(normalizeEnglish("um well so")) === null);

  // Duplicate verses must be flagged rather than presented as decided.
  const dup = new Tracker(index);
  const duplicate = dup.feed(normalizeEnglish("And the LORD spake unto Moses, saying"));
  check(
    "duplicate text is flagged as an ambiguous reference",
    duplicate?.ambiguousReference === true,
  );
  check(
    "an ambiguous reference reports low confidence",
    (duplicate?.confidence ?? 1) < 0.05,
    `confidence ${duplicate?.confidence.toFixed(3)}`,
  );
}

const kjv = verifyCorpus("kjv");
verifyCorpus("quran");
verifyTrackerBehaviour(kjv);
verifyTracking(kjv);

console.log(
  failures === 0
    ? "\nall checks passed — TypeScript matches the Python harness\n"
    : `\n${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
