"""BM25 verse matcher over an inverted index.

This is the component Phase 1 refines, but Phase 0 needs it now: without a matcher
there is no verse-identification number to measure, only a word error rate.

Two lookup modes, mirroring the product's own two modes:

    search(query)              acquire — rank the whole corpus
    search(query, near=verse)  track   — rank only a window around a known position

Run directly to self-check:

    python3 eval/matcher.py
"""

from __future__ import annotations

import math
import sys
from collections import defaultdict

from corpus import Verse, load, normalize_arabic, normalize_english

K1 = 1.5  # term-frequency saturation
B = 0.75  # length normalization

# Candidates are drawn from the rarest query terms only. Common words match most of
# the corpus and contribute almost nothing to the score, so pulling their postings
# costs time without changing the ranking.
RAREST_TERMS = 8


class Index:
    """An inverted index with BM25 scoring over a verse list."""

    def __init__(self, verses: list[Verse]) -> None:
        self.verses = verses
        self.postings: dict[str, list[tuple[int, int]]] = defaultdict(list)
        self.lengths: list[int] = []

        for verse in verses:
            terms = verse.match_text.split()
            self.lengths.append(len(terms))
            counts: dict[str, int] = defaultdict(int)
            for term in terms:
                counts[term] += 1
            for term, count in counts.items():
                self.postings[term].append((verse.id, count))

        self.avg_length = sum(self.lengths) / len(self.lengths)
        total = len(verses)
        self.idf = {
            term: math.log(1 + (total - len(posting) + 0.5) / (len(posting) + 0.5))
            for term, posting in self.postings.items()
        }

    def _candidates(self, terms: list[str]) -> set[int]:
        ranked = sorted(
            {t for t in terms if t in self.postings},
            key=lambda t: self.idf[t],
            reverse=True,
        )
        candidates: set[int] = set()
        for term in ranked[:RAREST_TERMS]:
            candidates.update(verse_id for verse_id, _ in self.postings[term])
        return candidates

    def _score(self, terms: list[str], verse_ids) -> dict[int, float]:
        scores: dict[int, float] = defaultdict(float)
        wanted = set(verse_ids)
        for term in terms:
            posting = self.postings.get(term)
            if not posting:
                continue
            idf = self.idf[term]
            for verse_id, count in posting:
                if verse_id not in wanted:
                    continue
                norm = 1 - B + B * self.lengths[verse_id] / self.avg_length
                scores[verse_id] += idf * count * (K1 + 1) / (count + K1 * norm)
        return scores

    def search(
        self,
        query: str,
        top_k: int = 5,
        near: int | None = None,
        window: tuple[int, int] = (-2, 10),
    ) -> list[tuple[Verse, float]]:
        """Rank verses against query.

        With `near`, only the window around that verse id is scored — the tracking
        mode, where context has already collapsed the search space.
        """
        terms = query.split()
        if not terms:
            return []

        if near is None:
            candidates = self._candidates(terms)
        else:
            lo = max(0, near + window[0])
            hi = min(len(self.verses), near + window[1] + 1)
            candidates = set(range(lo, hi))

        scores = self._score(terms, candidates)
        ranked = sorted(scores.items(), key=lambda kv: kv[1], reverse=True)[:top_k]
        return [(self.verses[verse_id], score) for verse_id, score in ranked]


def build(name: str) -> Index:
    return Index(load(name))


def normalize_for(corpus: str, text: str) -> str:
    return normalize_arabic(text) if corpus == "quran" else normalize_english(text)


# --------------------------------------------------------------------------- #
# Self-check
# --------------------------------------------------------------------------- #


def check() -> None:
    """Exact text must rank first, and degraded text must still resolve."""
    kjv = build("kjv")

    exact = "for god so loved the world that he gave his only begotten son"
    top = kjv.search(exact)
    assert top[0][0].ref == "John 3:16", f"exact lookup returned {top[0][0].ref}"

    # Half the words dropped, as speech recognition would drop them.
    partial = "god loved world gave only begotten son"
    assert kjv.search(partial)[0][0].ref == "John 3:16"

    # A phrase that recurs verbatim across the corpus must not resolve confidently.
    common = kjv.search("and it came to pass")
    occurrences = sum(1 for v in kjv.verses if "and it came to pass" in v.match_text)
    assert occurrences > 300, f"expected the phrase to be common, found {occurrences}"
    assert len(common) == 5, "a generic phrase should still return a ranked list"

    # Tracking: given the position, the next verse wins inside the window even
    # though its own text is generic.
    psalm23_1 = next(v for v in kjv.verses if v.ref == "Psalms 23:1")
    tracked = kjv.search(
        normalize_english("He maketh me to lie down in green pastures"),
        near=psalm23_1.id,
    )
    assert tracked[0][0].ref == "Psalms 23:2", tracked[0][0].ref

    quran = build("quran")
    ayat_al_kursi = next(v for v in quran.verses if v.ref == "2:255")
    hit = quran.search(ayat_al_kursi.match_text)
    assert hit[0][0].ref == "2:255", f"Quran exact lookup returned {hit[0][0].ref}"

    # Undiacritized input — how recognition output arrives — must still match.
    assert quran.search(normalize_arabic("قل هو الله احد"))[0][0].ref == "112:1"

    print(
        f"matcher check passed — KJV {len(kjv.verses):,} verses "
        f"({len(kjv.postings):,} terms), Quran {len(quran.verses):,} ayat "
        f"({len(quran.postings):,} terms)"
    )


if __name__ == "__main__":
    check()
