"""Corpus acquisition and normalization for the Scripture Live evaluation harness.

Fetches the two target corpora into eval/data/ as flat verse lists and provides the
text normalizers the matcher and the scorer both depend on.

Run directly to fetch and self-check:

    python3 eval/corpus.py
"""

from __future__ import annotations

import json
import re
import sys
import unicodedata
import urllib.request
from dataclasses import dataclass, asdict
from pathlib import Path

DATA = Path(__file__).parent / "data"

KJV_BOOKS_URL = "https://raw.githubusercontent.com/aruljohn/Bible-kjv/master/Books.json"
KJV_BOOK_URL = "https://raw.githubusercontent.com/aruljohn/Bible-kjv/master/{book}.json"
QURAN_URL = "https://raw.githubusercontent.com/fawazahmed0/quran-api/1/editions/ara-quransimple.json"
QURAN_UTHMANI_URL = (
    "https://raw.githubusercontent.com/fawazahmed0/quran-api/1/editions/ara-quranuthmanienc.json"
)

KJV_VERSES = 31_102
KJV_BOOK_COUNT = 66
QURAN_AYAT = 6_236
QURAN_SURAHS = 114

# At-Tawbah is the one surah with no basmala, so nothing is prepended to 9:1.
SURAH_WITHOUT_BASMALA = 9


@dataclass(frozen=True)
class Verse:
    """One addressable unit of scripture, in canonical order."""

    id: int  # 0-based ordinal within the corpus
    ref: str  # human-readable, e.g. "Psalms 23:1" or "2:255"
    book: str  # book name, or surah number as a string
    chapter: int
    verse: int
    text: str  # display form, as published
    match_text: str  # normalized form the matcher indexes


# --------------------------------------------------------------------------- #
# Normalization
# --------------------------------------------------------------------------- #

# Harakat, Quranic annotation signs, superscript alif, tatweel.
_ARABIC_STRIP = re.compile(
    "["
    "ؐ-ؚ"  # Arabic signs
    "ً-ٟ"  # harakat
    "ٰ"  # superscript alif
    "ۖ-ۭ"  # Quranic annotation
    "ـ"  # tatweel
    "]"
)

_ARABIC_FOLD = str.maketrans(
    {
        "آ": "ا",  # آ -> ا
        "أ": "ا",  # أ -> ا
        "إ": "ا",  # إ -> ا
        "ٱ": "ا",  # ٱ -> ا
        "ى": "ي",  # ى -> ي
        "ة": "ه",  # ة -> ه
    }
)


def normalize_arabic(text: str) -> str:
    """Fold Arabic to the orthography-insensitive form used for matching.

    Recitation is matched on this form; the Uthmani text is what gets displayed.
    """
    text = unicodedata.normalize("NFC", text)
    text = text.replace("﻿", "").replace("‌", "").replace("‍", "")
    text = _ARABIC_STRIP.sub("", text)
    text = text.translate(_ARABIC_FOLD)
    return re.sub(r"\s+", " ", text).strip()


def normalize_english(text: str) -> str:
    """Fold English to the form used for matching.

    Speech recognition emits no punctuation and no casing worth trusting, so the
    ground truth is reduced to the same shape its output will have.
    """
    text = unicodedata.normalize("NFC", text)
    text = text.lower().replace("’", "'").replace("‘", "'")
    text = re.sub(r"[^a-z0-9\s']", " ", text)
    return re.sub(r"\s+", " ", text).strip()


# --------------------------------------------------------------------------- #
# Fetch
# --------------------------------------------------------------------------- #


def _get_json(url: str) -> dict | list:
    with urllib.request.urlopen(url, timeout=60) as response:
        return json.loads(response.read().decode("utf-8"))


def fetch_kjv() -> list[Verse]:
    books = _get_json(KJV_BOOKS_URL)
    if len(books) != KJV_BOOK_COUNT:
        raise ValueError(f"expected {KJV_BOOK_COUNT} books, source listed {len(books)}")

    verses: list[Verse] = []
    for book in books:
        # Book names contain spaces ("1 Samuel") but the filenames drop them entirely.
        payload = _get_json(KJV_BOOK_URL.format(book=book.replace(" ", "")))
        for chapter in payload["chapters"]:
            chapter_no = int(chapter["chapter"])
            for entry in chapter["verses"]:
                verse_no = int(entry["verse"])
                text = entry["text"].strip()
                verses.append(
                    Verse(
                        id=len(verses),
                        ref=f"{book} {chapter_no}:{verse_no}",
                        book=book,
                        chapter=chapter_no,
                        verse=verse_no,
                        text=text,
                        match_text=normalize_english(text),
                    )
                )
        print(f"  {book:<20} {len(verses):>6} verses so far", file=sys.stderr)
    return verses


def _strip_prepended_basmala(text: str, surah: int, verse: int, basmala: str) -> str:
    """Remove the basmala these APIs prepend to the first ayah of most surahs.

    Al-Fatiha counts the basmala as ayah 1 and At-Tawbah has none, so both are left
    alone. Every other surah's first ayah arrives with the basmala glued to the front,
    which would make per-ayah recitation audio mismatch its own ground truth.
    """
    if verse != 1 or surah in (1, SURAH_WITHOUT_BASMALA):
        return text
    if not normalize_arabic(text).startswith(basmala):
        return text
    # Walk the display string forward until its normalized prefix clears the basmala.
    for cut in range(1, len(text) + 1):
        if not normalize_arabic(text[:cut]).rstrip().rstrip(basmala[-1]):
            continue
        if normalize_arabic(text[cut:]) == normalize_arabic(text)[len(basmala) :].strip():
            return text[cut:].strip()
    return text


def fetch_quran() -> list[Verse]:
    simple = _get_json(QURAN_URL)["quran"]
    uthmani = {(a["chapter"], a["verse"]): a["text"] for a in _get_json(QURAN_UTHMANI_URL)["quran"]}
    if len(simple) != QURAN_AYAT:
        raise ValueError(f"expected {QURAN_AYAT} ayat, source listed {len(simple)}")

    basmala = normalize_arabic(simple[0]["text"])

    verses: list[Verse] = []
    for ayah in simple:
        surah, number = ayah["chapter"], ayah["verse"]
        display = uthmani.get((surah, number), ayah["text"]).strip()
        display = _strip_prepended_basmala(display, surah, number, basmala)
        match_source = _strip_prepended_basmala(ayah["text"], surah, number, basmala)
        verses.append(
            Verse(
                id=len(verses),
                ref=f"{surah}:{number}",
                book=str(surah),
                chapter=surah,
                verse=number,
                text=display,
                match_text=normalize_arabic(match_source),
            )
        )
    return verses


def save(name: str, verses: list[Verse]) -> Path:
    DATA.mkdir(parents=True, exist_ok=True)
    path = DATA / f"{name}.json"
    path.write_text(
        json.dumps([asdict(v) for v in verses], ensure_ascii=False), encoding="utf-8"
    )
    return path


def load(name: str) -> list[Verse]:
    path = DATA / f"{name}.json"
    if not path.exists():
        raise FileNotFoundError(f"{path} missing — run: python3 eval/corpus.py")
    return [Verse(**v) for v in json.loads(path.read_text(encoding="utf-8"))]


# --------------------------------------------------------------------------- #
# Self-check
# --------------------------------------------------------------------------- #


def check() -> None:
    """Assert the corpora are complete and the Quran basmala fix actually applied."""
    kjv = load("kjv")
    assert len(kjv) == KJV_VERSES, f"KJV has {len(kjv)} verses, expected {KJV_VERSES}"
    assert len({v.book for v in kjv}) == KJV_BOOK_COUNT
    assert kjv[0].ref == "Genesis 1:1", kjv[0].ref
    assert kjv[-1].ref == "Revelation 22:21", kjv[-1].ref
    assert kjv[0].match_text == "in the beginning god created the heaven and the earth"
    assert all(v.match_text for v in kjv), "a KJV verse normalized to nothing"

    quran = load("quran")
    assert len(quran) == QURAN_AYAT, f"Quran has {len(quran)} ayat, expected {QURAN_AYAT}"
    assert len({v.chapter for v in quran}) == QURAN_SURAHS
    assert quran[0].ref == "1:1" and quran[-1].ref == "114:6"

    # Normalization must remove every diacritic from the matching form.
    assert not _ARABIC_STRIP.search("".join(v.match_text for v in quran[:200]))

    by_ref = {v.ref: v for v in quran}
    basmala = by_ref["1:1"].match_text

    # 2:1 is Alif-Lam-Meem alone once the prepended basmala is stripped.
    assert by_ref["2:1"].match_text == "الم", repr(by_ref["2:1"].match_text)
    # 9:1 has no basmala to strip and must survive untouched.
    assert not by_ref["9:1"].match_text.startswith(basmala)
    # 1:1 IS the basmala and must not be emptied.
    assert by_ref["1:1"].match_text == basmala
    # No other surah opener should still carry it.
    leaked = [
        v.ref
        for v in quran
        if v.verse == 1 and v.chapter != 1 and v.match_text.startswith(basmala)
    ]
    assert not leaked, f"basmala still prepended on {leaked[:5]}"
    assert all(v.match_text for v in quran), "an ayah normalized to nothing"

    print(f"corpus check passed — KJV {len(kjv):,} verses, Quran {len(quran):,} ayat")


if __name__ == "__main__":
    if not (DATA / "kjv.json").exists() or "--refetch" in sys.argv:
        print("fetching KJV (66 requests)...", file=sys.stderr)
        save("kjv", fetch_kjv())
    if not (DATA / "quran.json").exists() or "--refetch" in sys.argv:
        print("fetching Quran...", file=sys.stderr)
        save("quran", fetch_quran())
    check()
