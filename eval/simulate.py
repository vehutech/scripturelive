"""Measure matcher robustness without running recognition.

Spike B showed real transcripts arriving at roughly 60% WER but still resolving to
the right ayah most of the time. That measurement costs half an hour of CPU and
covers 40 ayat. This runs the whole corpus in seconds by corrupting the ground truth
the way recognition actually corrupts it, so Phase 1 can tune BM25 against every
verse instead of a sample.

The corruption model mirrors what whisper-base was observed doing to recitation:
dropping words, substituting near-misses, and repeating phrases it had already
emitted.

    python3 eval/simulate.py --corpus quran --wer 0.6
    python3 eval/simulate.py --corpus kjv --sweep
"""

from __future__ import annotations

import argparse
import random
import statistics

from corpus import load
from matcher import Index

# Observed mix in the whisper-base Arabic transcripts: mostly dropped words, some
# substitutions, occasional repeated phrase.
P_DELETE = 0.55
P_SUBSTITUTE = 0.30
P_REPEAT = 0.15


def corrupt(tokens: list[str], rate: float, vocabulary: list[str], rng: random.Random) -> list[str]:
    """Degrade a token list at approximately `rate` word error rate."""
    out: list[str] = []
    for token in tokens:
        if rng.random() >= rate:
            out.append(token)
            continue
        roll = rng.random()
        if roll < P_DELETE:
            continue
        if roll < P_DELETE + P_SUBSTITUTE:
            out.append(rng.choice(vocabulary))
        else:
            out.extend([token, token])
    return out


def run(corpus: str, rate: float, sample: int, seed: int) -> dict:
    verses = load(corpus)
    index = Index(verses)
    vocabulary = list(index.postings.keys())
    rng = random.Random(seed)

    population = verses if sample >= len(verses) else rng.sample(verses, sample)

    acquire_hits = tracked_hits = top5_hits = text_hits = 0
    by_length: dict[str, list[bool]] = {}
    empties = 0

    for verse in population:
        tokens = verse.match_text.split()
        degraded = corrupt(tokens, rate, vocabulary, rng)
        if not degraded:
            # Everything dropped — no signal at all, counted as a miss rather than skipped.
            empties += 1
            continue
        query = " ".join(degraded)

        hits = index.search(query, top_k=5)
        tracked = index.search(query, top_k=1, near=max(0, verse.id - 1))

        first = bool(hits) and hits[0][0].id == verse.id
        acquire_hits += first
        top5_hits += any(v.id == verse.id for v, _ in hits)
        tracked_hits += bool(tracked) and tracked[0][0].id == verse.id
        # Identical verses recur — Ar-Rahman's refrain 31 times, "and the LORD spake
        # unto Moses saying" 72 times — so returning the right words under a
        # neighbouring reference is not a matcher failure.
        text_hits += bool(hits) and hits[0][0].match_text == verse.match_text

        bucket = (
            "1-4" if len(tokens) <= 4 else
            "5-9" if len(tokens) <= 9 else
            "10-19" if len(tokens) <= 19 else "20+"
        )
        by_length.setdefault(bucket, []).append(first)

    total = len(population)
    return {
        "corpus": corpus,
        "rate": rate,
        "n": total,
        "acquire_top1": acquire_hits / total,
        "acquire_top5": top5_hits / total,
        "acquire_text": text_hits / total,
        "tracked_top1": tracked_hits / total,
        "wiped_out": empties / total,
        "by_length": {
            k: (sum(v) / len(v), len(v))
            for k, v in sorted(by_length.items(), key=lambda kv: len(kv[0]))
        },
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--corpus", choices=["kjv", "quran"], default="quran")
    parser.add_argument("--wer", type=float, default=0.6)
    parser.add_argument("--sample", type=int, default=1500)
    parser.add_argument("--seed", type=int, default=17)
    parser.add_argument("--sweep", action="store_true", help="run 0.2 through 0.8")
    args = parser.parse_args()

    rates = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8] if args.sweep else [args.wer]

    print(f"  {args.corpus}, n={args.sample}, seed={args.seed}\n")
    print(
        f"  {'WER':>5}  {'acquire top-1':>14}  {'top-5':>7}  "
        f"{'right text':>11}  {'tracked top-1':>14}"
    )
    print("  " + "-" * 62)
    results = []
    for rate in rates:
        r = run(args.corpus, rate, args.sample, args.seed)
        results.append(r)
        print(
            f"  {rate:>4.0%}  {r['acquire_top1']:>13.1%}  {r['acquire_top5']:>6.1%}  "
            f"{r['acquire_text']:>10.1%}  {r['tracked_top1']:>13.1%}"
        )

    last = results[-1]
    print(f"\n  at {last['rate']:.0%} WER, by ground-truth length:")
    for bucket, (accuracy, count) in last["by_length"].items():
        print(f"    {bucket:<6} n={count:<5} acquire top-1 {accuracy:>6.1%}")
    if last["wiped_out"]:
        print(f"  {last['wiped_out']:.1%} of queries lost every token")


def check() -> None:
    """Clean text must resolve perfectly; heavy corruption must degrade, not crash."""
    clean = run("quran", 0.0, 300, seed=1)
    # Strict verse-id accuracy is capped by duplicate verses, so the honest clean-text
    # assertion is on returning the right words, not the right reference.
    assert clean["acquire_text"] > 0.99, clean["acquire_text"]
    assert clean["acquire_top1"] > 0.93, clean["acquire_top1"]

    heavy = run("quran", 0.8, 300, seed=1)
    assert heavy["acquire_top1"] < clean["acquire_top1"], "corruption did nothing"

    # Tracking must never be worse than acquiring — the window is a strict subset.
    mid = run("quran", 0.6, 300, seed=1)
    assert mid["tracked_top1"] >= mid["acquire_top1"], (
        f"tracked {mid['tracked_top1']:.3f} < acquire {mid['acquire_top1']:.3f}"
    )
    print("simulate check passed")


if __name__ == "__main__":
    import sys

    if "--check" in sys.argv:
        check()
    else:
        main()
