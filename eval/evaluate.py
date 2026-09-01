"""Phase 0 evaluation harness: audio in, verse id out, scored automatically.

Measures the two things that fail independently, so a bad number points somewhere:

    WER            can recognition handle this kind of speech at all
    top-1 / top-5  can the matcher resolve the recognized text to the right verse

Usage:

    python3 eval/evaluate.py --spike B --limit 6      # fast smoke test
    python3 eval/evaluate.py --spike B --model small  # full Quran run
    python3 eval/evaluate.py --spike A                # continuous English reading
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from dataclasses import dataclass
from pathlib import Path

import jiwer
from faster_whisper import WhisperModel

from corpus import load
from matcher import Index, normalize_for

DATA = Path(__file__).parent / "data"


# --------------------------------------------------------------------------- #
# Recognition backend
# --------------------------------------------------------------------------- #


class Whisper:
    """faster-whisper backend. Swappable — the runner only needs .transcribe()."""

    def __init__(self, model: str = "base", compute_type: str = "int8") -> None:
        self.name = f"whisper-{model}"
        self.model = WhisperModel(model, device="cpu", compute_type=compute_type)

    def transcribe(self, path: Path, language: str) -> tuple[str, list[str]]:
        segments, _ = self.model.transcribe(
            str(path), language=language, beam_size=5, vad_filter=False
        )
        parts = [s.text.strip() for s in segments]
        return " ".join(parts), parts


# --------------------------------------------------------------------------- #
# Scoring
# --------------------------------------------------------------------------- #


@dataclass
class Result:
    ref: str
    source: str
    wer: float
    rank: int | None  # 1-based rank of the true verse, None if outside top-5
    rank_tracked: int | None  # same, but searching only a window around the prior verse
    ref_tokens: int  # length of the ground truth, the main driver of ambiguity
    predicted: str
    transcript: str


def score_clip(entry: dict, index: Index, verses_by_id: dict, asr: Whisper) -> Result:
    """Score one single-verse clip: WER against its text, rank of its verse.

    Scores the same clip twice — once against the whole corpus (acquire) and once
    against a window around the preceding verse (track). The tracked number assumes
    the position was already known, so it bounds what tracking can buy.
    """
    audio = DATA / entry["audio"]
    raw, _ = asr.transcribe(audio, entry["language"])

    corpus = entry["corpus"]
    truth = verses_by_id[entry["verse_ids"][0]]
    hypothesis = normalize_for(corpus, raw)
    reference = truth.match_text

    wer = jiwer.wer(reference, hypothesis) if reference and hypothesis else 1.0

    def rank_of(hits) -> int | None:
        return next(
            (i + 1 for i, (verse, _) in enumerate(hits) if verse.id == truth.id), None
        )

    hits = index.search(hypothesis, top_k=5)
    tracked = index.search(hypothesis, top_k=5, near=max(0, truth.id - 1))

    return Result(
        ref=truth.ref,
        source=entry.get("reciter", entry["source"]),
        wer=wer,
        rank=rank_of(hits),
        rank_tracked=rank_of(tracked),
        ref_tokens=len(reference.split()),
        predicted=hits[0][0].ref if hits else "—",
        transcript=raw.strip(),
    )


# A window search always returns something, so tracking needs an explicit way out or
# one bad lock is permanent. Unlock when a global search beats the window by this
# margin for this many consecutive segments.
JUMP_MARGIN = 1.35
UNLOCK_AFTER = 2
# Below this BM25 score a segment is noise — a LibriVox preamble, a chapter heading —
# and must not be allowed to set the position.
LOCK_FLOOR = 12.0


def transcribe_cached(entry: dict, asr: Whisper) -> tuple[str, list[str]]:
    """Transcribe once and cache, so tracking changes do not pay for recognition again."""
    audio = DATA / entry["audio"]
    cache = DATA / f"transcript_{audio.stem}_{asr.name}.json"
    if cache.exists():
        payload = json.loads(cache.read_text(encoding="utf-8"))
        print(f"  using cached transcript ({len(payload['segments'])} segments)", file=sys.stderr)
        return payload["raw"], payload["segments"]

    print(f"  transcribing {audio.name} (this takes a few minutes)...", file=sys.stderr)
    started = time.time()
    raw, segments = asr.transcribe(audio, entry["language"])
    cache.write_text(
        json.dumps(
            {"raw": raw, "segments": segments, "seconds": round(time.time() - started, 1)},
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return raw, segments


def track(segments: list[str], index: Index, corpus: str) -> list[int]:
    """Walk segments in order, returning the verse id chosen for each.

    Runs both searches every frame: a window around the current position and a global
    search. The window wins while it holds, and the global result takes over once it
    has beaten the window convincingly for several consecutive segments.
    """
    position: int | None = None
    consecutive_better = 0
    chosen: list[int] = []

    for segment in segments:
        query = normalize_for(corpus, segment)
        if len(query.split()) < 3:
            continue

        globally = index.search(query, top_k=1)
        windowed = index.search(query, top_k=1, near=position) if position is not None else []

        if not globally and not windowed:
            continue

        if not windowed:
            # No lock yet. Only a confident global hit is allowed to establish one.
            verse, score = globally[0]
            if score >= LOCK_FLOOR:
                position = verse.id
                chosen.append(verse.id)
            continue

        window_verse, window_score = windowed[0]
        global_score = globally[0][1] if globally else 0.0

        if global_score > window_score * JUMP_MARGIN:
            consecutive_better += 1
        else:
            consecutive_better = 0

        if consecutive_better >= UNLOCK_AFTER and globally:
            position = globally[0][0].id
            consecutive_better = 0
        else:
            position = window_verse.id
        chosen.append(position)

    return chosen


def score_continuous(entry: dict, index: Index, asr: Whisper) -> dict:
    """Score the continuous reading: WER over the whole text, plus tracking behaviour."""
    started = time.time()
    raw, segments = transcribe_cached(entry, asr)

    corpus = entry["corpus"]
    truth_ids = entry["verse_ids"]
    verses = {v.id: v for v in load(corpus)}

    reference = " ".join(verses[i].match_text for i in truth_ids)
    hypothesis = normalize_for(corpus, raw)
    wer = jiwer.wer(reference, hypothesis)

    chosen = track(segments, index, corpus)
    span = set(truth_ids)
    in_span = sum(1 for verse_id in chosen if verse_id in span)
    in_order = sum(1 for a, b in zip(chosen, chosen[1:]) if b >= a)
    reached = len({verse_id for verse_id in chosen if verse_id in span})

    return {
        "wer": wer,
        "segments": len(segments),
        "matched": len(chosen),
        "in_span_rate": in_span / len(chosen) if chosen else 0.0,
        "in_order_rate": in_order / (len(chosen) - 1) if len(chosen) > 1 else 0.0,
        "verses_reached": reached,
        "verses_in_reading": len(span),
        "coverage": reached / len(span) if span else 0.0,
        "audio_seconds": round(time.time() - started, 1),
        "transcript_head": raw.strip()[:220],
    }


# --------------------------------------------------------------------------- #
# Runner
# --------------------------------------------------------------------------- #


def report_clips(results: list[Result], model: str) -> dict:
    wers = [r.wer for r in results]
    top1 = sum(1 for r in results if r.rank == 1) / len(results)
    top5 = sum(1 for r in results if r.rank is not None) / len(results)

    print(f"\n  {'ayah':<10} {'reciter':<30} {'WER':>7}  {'rank':>5}  predicted")
    print("  " + "-" * 72)
    for r in sorted(results, key=lambda r: -r.wer)[:12]:
        rank = str(r.rank) if r.rank else "miss"
        flag = " " if r.rank == 1 else "*"
        print(
            f" {flag}{r.ref:<10} {r.source:<30} {r.wer:>6.1%}  {rank:>5}  {r.predicted}"
        )
    if len(results) > 12:
        print(f"  ... {len(results) - 12} more")

    tracked1 = sum(1 for r in results if r.rank_tracked == 1) / len(results)

    summary = {
        "model": model,
        "clips": len(results),
        "wer_mean": statistics.mean(wers),
        "wer_median": statistics.median(wers),
        "top1": top1,
        "top5": top5,
        "top1_tracked": tracked1,
        "clips_detail": [
            {
                "ref": r.ref,
                "source": r.source,
                "wer": round(r.wer, 4),
                "rank": r.rank,
                "rank_tracked": r.rank_tracked,
                "ref_tokens": r.ref_tokens,
                "predicted": r.predicted,
                "transcript": r.transcript,
            }
            for r in results
        ],
    }
    print(
        f"\n  {model}: {len(results)} clips | "
        f"WER mean {summary['wer_mean']:.1%} median {summary['wer_median']:.1%} | "
        f"top-1 {top1:.1%} | top-5 {top5:.1%} | tracked top-1 {tracked1:.1%}"
    )

    # Length is the expected driver: a short ayah carries few discriminative terms.
    print("\n  by ground-truth length:")
    buckets = [("1-4 words", 1, 4), ("5-9", 5, 9), ("10-19", 10, 19), ("20+", 20, 10**6)]
    for label, lo, hi in buckets:
        group = [r for r in results if lo <= r.ref_tokens <= hi]
        if not group:
            continue
        acquire = sum(1 for r in group if r.rank == 1) / len(group)
        track = sum(1 for r in group if r.rank_tracked == 1) / len(group)
        print(
            f"    {label:<12} n={len(group):<4} acquire {acquire:>6.1%}   tracked {track:>6.1%}"
        )

    by_reciter: dict[str, list[Result]] = {}
    for r in results:
        by_reciter.setdefault(r.source, []).append(r)
    if len(by_reciter) > 1:
        print("\n  per reciter:")
        for source, group in sorted(by_reciter.items()):
            hit = sum(1 for r in group if r.rank == 1) / len(group)
            print(
                f"    {source:<32} WER {statistics.median(r.wer for r in group):>6.1%}"
                f"  top-1 {hit:>6.1%}"
            )
        summary["per_reciter"] = {
            s: {
                "wer_median": statistics.median(r.wer for r in g),
                "top1": sum(1 for r in g if r.rank == 1) / len(g),
            }
            for s, g in by_reciter.items()
        }
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--spike", choices=["A", "B"], required=True)
    parser.add_argument("--model", default="base", help="whisper size: tiny/base/small")
    parser.add_argument("--limit", type=int, help="score only the first N clips")
    args = parser.parse_args()

    manifest = json.loads((DATA / "manifest.json").read_text(encoding="utf-8"))
    entries = [e for e in manifest if e["spike"] == args.spike]
    if not entries:
        sys.exit(f"no Spike {args.spike} entries in the manifest — run fetch_audio.py")

    corpus = entries[0]["corpus"]
    print(f"Spike {args.spike} — {corpus}, {args.model}", file=sys.stderr)
    index = Index(load(corpus))
    asr = Whisper(args.model)

    started = time.time()
    if args.spike == "A":
        summary = score_continuous(entries[0], index, asr)
        summary["model"] = args.model
        print(f"\n  transcript opens: {summary['transcript_head']!r}\n")
        print(f"  WER over the full reading  {summary['wer']:.1%}")
        print(f"  segments recognized        {summary['segments']}")
        print(f"  matched inside the book    {summary['in_span_rate']:.1%}")
        print(f"  matches in reading order   {summary['in_order_rate']:.1%}")
        print(
            f"  verses reached             {summary['verses_reached']}"
            f"/{summary['verses_in_reading']}  ({summary['coverage']:.1%})"
        )
    else:
        verses_by_id = {v.id: v for v in load(corpus)}
        if args.limit:
            entries = entries[: args.limit]
        results = []
        for i, entry in enumerate(entries, 1):
            results.append(score_clip(entry, index, verses_by_id, asr))
            print(f"  {i}/{len(entries)}", end="\r", file=sys.stderr)
        summary = report_clips(results, args.model)

    summary["seconds"] = round(time.time() - started, 1)
    out = DATA / f"results_spike{args.spike}_{args.model}.json"
    out.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\n  written to {out.relative_to(Path.cwd()) if out.is_relative_to(Path.cwd()) else out}")


if __name__ == "__main__":
    main()
