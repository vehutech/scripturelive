"""Export the corpora into the compact form the app ships.

The evaluation JSON carries per-verse metadata the browser can reconstruct for free,
which more than doubles the download. What ships instead is the verse text alone, one
line per verse in canonical order, plus a small structure file naming each book and its
verse counts per chapter. That is 4.1 MB for the KJV, 1.2 MB gzipped.

    python3 eval/export_web.py
"""

from __future__ import annotations

import gzip
import json
from pathlib import Path

from corpus import load
from matcher import normalize_for

OUT = Path(__file__).parent.parent / "app" / "public" / "data"


def export(name: str) -> None:
    verses = load(name)

    # Books in first-appearance order, each holding its per-chapter verse counts.
    books: list[dict] = []
    for verse in verses:
        if not books or books[-1]["name"] != verse.book:
            books.append({"name": verse.book, "chapters": []})
        chapters = books[-1]["chapters"]
        while len(chapters) < verse.chapter:
            chapters.append(0)
        chapters[verse.chapter - 1] += 1

    for verse in verses:
        assert "\n" not in verse.text, f"{verse.ref} contains a newline"

    # The Quran's display text is Uthmani but its matching text comes from the simple
    # edition, and the two differ orthographically in ways no folding reconciles —
    # الصلوة against الصلاة, superscript alif against a written one. So the match text
    # ships alongside rather than being derived in the browser. The KJV needs no such
    # file: normalizing its display text reproduces the matching text exactly.
    needs_match_file = any(normalize_for(name, v.text) != v.match_text for v in verses)

    OUT.mkdir(parents=True, exist_ok=True)
    text_path = OUT / f"{name}.txt"
    text_path.write_text("\n".join(v.text for v in verses), encoding="utf-8")
    if needs_match_file:
        (OUT / f"{name}.match.txt").write_text(
            "\n".join(v.match_text for v in verses), encoding="utf-8"
        )
    (OUT / f"{name}.idx.json").write_text(
        json.dumps({"books": books, "hasMatchFile": needs_match_file}, ensure_ascii=False),
        encoding="utf-8",
    )

    # The structure file must reconstruct every reference exactly.
    rebuilt: list[str] = []
    for book in books:
        for chapter_no, count in enumerate(book["chapters"], start=1):
            for verse_no in range(1, count + 1):
                rebuilt.append(
                    f"{book['name']} {chapter_no}:{verse_no}"
                    if name == "kjv"
                    else f"{chapter_no}:{verse_no}"
                )
    expected = [v.ref for v in verses]
    assert rebuilt == expected, (
        f"reference reconstruction diverged at "
        f"{next(i for i, (a, b) in enumerate(zip(rebuilt, expected)) if a != b)}"
    )

    shipped = [text_path.read_bytes()]
    if needs_match_file:
        shipped.append((OUT / f"{name}.match.txt").read_bytes())
    raw = b"".join(shipped)
    print(
        f"  {name}: {len(verses):,} verses, {len(books)} books | "
        f"{len(raw) / 1e6:.1f} MB ({len(gzip.compress(raw)) / 1e6:.2f} MB gzipped)"
        f"{' (+ separate match text)' if needs_match_file else ''}"
    )


if __name__ == "__main__":
    for corpus in ("kjv", "quran"):
        export(corpus)
    print(f"written to {OUT}")
