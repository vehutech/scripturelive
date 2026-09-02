"""Emit the fixtures the TypeScript port is verified against.

The evaluation harness measures the Python matcher, but the browser runs the TypeScript
one. If the two ever drift, every number the harness reports stops describing what
ships. These fixtures pin them together: a digest over every normalized verse, and exact
search rankings for a spread of queries.

    python3 eval/emit_fixtures.py
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

from corpus import load
from matcher import Index, normalize_for

OUT = Path(__file__).parent.parent / "app" / "src" / "fixtures.json"

QUERIES = {
    "kjv": [
        "for god so loved the world that he gave his only begotten son",
        "god loved world gave only begotten son",
        "and it came to pass",
        "the lord is my shepherd i shall not want",
        "he maketh me to lie down in green pastures",
        "in the beginning god created the heaven and the earth",
        "jesus wept",
        "trust in the lord with all thine heart",
        "and the lord spake unto moses saying",
        "be strong and of a good courage be not afraid",
    ],
    "quran": [
        "قل هو الله احد",
        "بسم الله الرحمن الرحيم",
        "فباي الاء ربكما تكذبان",
        "الحمد لله رب العالمين",
        "الم",
        "ان مع العسر يسرا",
    ],
}

# Tracked searches: (query, verse id to search around).
TRACKED = {
    "kjv": [("he maketh me to lie down in green pastures", "Psalms 23:1")],
    "quran": [("الحمد لله رب العالمين", "1:1")],
}


def digest(values: list[str]) -> str:
    sha = hashlib.sha256()
    for value in values:
        sha.update(value.encode("utf-8"))
        sha.update(b"\x00")
    return sha.hexdigest()


def heldout_clips() -> list[dict]:
    """The held-out Quran transcripts, so the TypeScript port can replay the same gate.

    Phase 0 and 3 measure the Python matcher against real recitation. Replaying the exact
    transcripts through the shipping implementation is what makes those numbers describe
    the code that runs in a browser rather than the code that produced them.
    """
    path = Path(__file__).parent / "data" / "results_spikeB-heldout_base.json"
    if not path.exists():
        return []
    detail = json.loads(path.read_text(encoding="utf-8")).get("clips_detail", [])
    return [
        {
            "ref": c["ref"],
            "reciter": c["source"],
            "transcript": c["transcript"],
            "refTokens": c["ref_tokens"],
        }
        for c in detail
    ]


def build() -> dict:
    fixtures: dict = {"corpora": {}}

    for name, queries in QUERIES.items():
        verses = load(name)
        index = Index(verses)

        searches = []
        for query in queries:
            normalized = normalize_for(name, query)
            searches.append(
                {
                    "query": query,
                    "normalized": normalized,
                    "hits": [
                        {"ref": verse.ref, "id": verse.id, "score": round(score, 6)}
                        for verse, score in index.search(normalized, top_k=5)
                    ],
                }
            )

        by_ref = {v.ref: v for v in verses}
        tracked = []
        for query, anchor in TRACKED[name]:
            normalized = normalize_for(name, query)
            tracked.append(
                {
                    "query": query,
                    "normalized": normalized,
                    "nearRef": anchor,
                    "nearId": by_ref[anchor].id,
                    "hits": [
                        {"ref": verse.ref, "id": verse.id, "score": round(score, 6)}
                        for verse, score in index.search(
                            normalized, top_k=5, near=by_ref[anchor].id
                        )
                    ],
                }
            )

        fixtures["corpora"][name] = {
            "verseCount": len(verses),
            "termCount": len(index.postings),
            # A digest over every normalized verse: if the TypeScript normalizer differs
            # anywhere in the corpus, this will not match.
            "matchTextDigest": digest([v.match_text for v in verses]),
            "refDigest": digest([v.ref for v in verses]),
            "searches": searches,
            "tracked": tracked,
        }

    fixtures["heldoutQuran"] = heldout_clips()
    return fixtures


if __name__ == "__main__":
    fixtures = build()
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(fixtures, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  held-out Quran clips: {len(fixtures['heldoutQuran'])}")
    for name, data in fixtures["corpora"].items():
        print(
            f"  {name}: {data['verseCount']:,} verses, {data['termCount']:,} terms, "
            f"{len(data['searches'])} searches, {len(data['tracked'])} tracked"
        )
    print(f"written to {OUT}")
