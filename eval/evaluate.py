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
    predicted: str
    transcript: str


def score_clip(entry: dict, index: Index, verses_by_id: dict, asr: Whisper) -> Result:
    """Score one single-verse clip: WER against its text, rank of its verse."""
    audio = DATA / entry["audio"]
    raw, _ = asr.transcribe(audio, entry["language"])

    corpus = entry["corpus"]
    truth = verses_by_id[entry["verse_ids"][0]]
    hypothesis = normalize_for(corpus, raw)
    reference = truth.match_text

    wer = jiwer.wer(reference, hypothesis) if reference and hypothesis else 1.0

    hits = index.search(hypothesis, top_k=5)
    rank = next(
        (i + 1 for i, (verse, _) in enumerate(hits) if verse.id == truth.id), None
    )

    return Result(
        ref=truth.ref,
        source=entry.get("reciter", entry["source"]),
        wer=wer,
        rank=rank,
        predicted=hits[0][0].ref if hits else "—",
        transcript=raw.strip(),
    )


def score_continuous(entry: dict, index: Index, asr: Whisper) -> dict:
    """Score the continuous reading: WER over the whole text, plus tracking behaviour."""
    audio = DATA / entry["audio"]
    print(f"  transcribing {audio.name} (this takes a few minutes)...", file=sys.stderr)
    started = time.time()
    raw, segments = asr.transcribe(audio, entry["language"])
    elapsed = time.time() - started

    corpus = entry["corpus"]
    truth_ids = entry["verse_ids"]
    verses = {v.id: v for v in load(corpus)}

    reference = " ".join(verses[i].match_text for i in truth_ids)
    hypothesis = normalize_for(corpus, raw)
    wer = jiwer.wer(reference, hypothesis)

    # Tracking: walk the segments in order, matching inside a window around the last
    # confident position, falling back to a global search when the window fails.
    span = set(truth_ids)
    position: int | None = None
    matched, in_span, in_order = 0, 0, 0
    previous: int | None = None

    for segment in segments:
        query = normalize_for(corpus, segment)
        if len(query.split()) < 3:
            continue
        hits = index.search(query, top_k=1, near=position)
        if not hits:
            hits = index.search(query, top_k=1)
        if not hits:
            continue
        verse = hits[0][0]
        matched += 1
        if verse.id in span:
            in_span += 1
        if previous is not None and verse.id >= previous:
            in_order += 1
        previous = position = verse.id

    covered = len({v for v in truth_ids})
    return {
        "wer": wer,
        "segments": len(segments),
        "matched": matched,
        "in_span_rate": in_span / matched if matched else 0.0,
        "in_order_rate": in_order / (matched - 1) if matched > 1 else 0.0,
        "verses_in_reading": covered,
        "audio_seconds": elapsed,
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

    summary = {
        "model": model,
        "clips": len(results),
        "wer_mean": statistics.mean(wers),
        "wer_median": statistics.median(wers),
        "top1": top1,
        "top5": top5,
    }
    print(
        f"\n  {model}: {len(results)} clips | "
        f"WER mean {summary['wer_mean']:.1%} median {summary['wer_median']:.1%} | "
        f"top-1 {top1:.1%} | top-5 {top5:.1%}"
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
        print(f"  matched inside Ephesians   {summary['in_span_rate']:.1%}")
        print(f"  matches in reading order   {summary['in_order_rate']:.1%}")
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
