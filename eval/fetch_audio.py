"""Fetch the labelled audio the Phase 0 spikes measure against.

Spike A (archaic English): a LibriVox reading of Ephesians — one continuous
17-minute human reading of 155 verses of known KJV text, which is the production
scenario rather than a clip-by-clip proxy.

Spike B (Quranic recitation): per-ayah clips from EveryAyah, where each file is
one ayah with a known ID, sampled across reciters so the gate is measured on
different voices rather than three takes of one.

Run directly:

    python3 eval/fetch_audio.py
"""

from __future__ import annotations

import json
import sys
import urllib.request
from pathlib import Path

from corpus import load

AUDIO = Path(__file__).parent / "data" / "audio"

LIBRIVOX_URL = (
    "https://ia600803.us.archive.org/15/items/"
    "ephesians_kjv_nt_librivox/ephesians_kjv.mp3"
)
LIBRIVOX_BOOK = "Ephesians"

EVERYAYAH_URL = "https://everyayah.com/data/{reciter}/{surah:03d}{ayah:03d}.mp3"
RECITERS = [
    "Alafasy_128kbps",
    "Husary_128kbps",
    "Abdul_Basit_Murattal_192kbps",
]
# Stride across the whole Quran so the sample spans short and long ayat, Meccan
# and Medinan, rather than clustering in one surah.
QURAN_SAMPLE_SIZE = 40


def _download(url: str, dest: Path) -> bool:
    """Fetch url to dest. Returns True if it downloaded, False if already present."""
    if dest.exists() and dest.stat().st_size > 0:
        return False
    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(url, timeout=120) as response, tmp.open("wb") as out:
        out.write(response.read())
    tmp.rename(dest)
    return True


def fetch_english() -> list[dict]:
    """Download the Ephesians reading and emit its verse-level ground truth."""
    dest = AUDIO / "english" / "ephesians_kjv.mp3"
    fetched = _download(LIBRIVOX_URL, dest)
    print(
        f"  {'downloaded' if fetched else 'cached'} {dest.name} "
        f"({dest.stat().st_size / 1e6:.1f} MB)",
        file=sys.stderr,
    )

    verses = [v for v in load("kjv") if v.book == LIBRIVOX_BOOK]
    if not verses:
        raise ValueError(f"no {LIBRIVOX_BOOK} verses in the KJV corpus")

    return [
        {
            "spike": "A",
            "corpus": "kjv",
            "audio": str(dest.relative_to(AUDIO.parent)),
            "source": "librivox/ephesians_kjv_nt_librivox",
            "kind": "continuous",
            "language": "en",
            # A continuous reading has no per-verse boundaries, so the label is the
            # ordered verse span the recording covers.
            "verse_ids": [v.id for v in verses],
            "refs": [v.ref for v in verses],
        }
    ]


def fetch_quran() -> list[dict]:
    """Download a strided ayah sample for each reciter."""
    ayat = load("quran")
    stride = len(ayat) // QURAN_SAMPLE_SIZE
    sample = [ayat[i * stride] for i in range(QURAN_SAMPLE_SIZE)]

    manifest: list[dict] = []
    downloaded = 0
    for reciter in RECITERS:
        for ayah in sample:
            dest = AUDIO / "quran" / reciter / f"{ayah.chapter:03d}{ayah.verse:03d}.mp3"
            url = EVERYAYAH_URL.format(
                reciter=reciter, surah=ayah.chapter, ayah=ayah.verse
            )
            try:
                if _download(url, dest):
                    downloaded += 1
            except Exception as error:  # noqa: BLE001 — one missing clip must not stop the run
                print(f"  skipped {reciter} {ayah.ref}: {error}", file=sys.stderr)
                continue
            manifest.append(
                {
                    "spike": "B",
                    "corpus": "quran",
                    "audio": str(dest.relative_to(AUDIO.parent)),
                    "source": f"everyayah/{reciter}",
                    "reciter": reciter,
                    "kind": "single_verse",
                    "language": "ar",
                    "verse_ids": [ayah.id],
                    "refs": [ayah.ref],
                }
            )
        print(f"  {reciter:<32} {len(sample)} clips", file=sys.stderr)
    print(f"  {downloaded} newly downloaded", file=sys.stderr)
    return manifest


def main() -> None:
    print("Spike A — LibriVox KJV:", file=sys.stderr)
    manifest = fetch_english()
    print("Spike B — EveryAyah recitation:", file=sys.stderr)
    manifest += fetch_quran()

    path = AUDIO.parent / "manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")

    clips = sum(1 for m in manifest if m["kind"] == "single_verse")
    total = sum(
        (AUDIO.parent / m["audio"]).stat().st_size
        for m in manifest
        if (AUDIO.parent / m["audio"]).exists()
    )
    assert clips == QURAN_SAMPLE_SIZE * len(RECITERS), f"expected clips, got {clips}"
    assert len(manifest[0]["verse_ids"]) == 155, "Ephesians should span 155 verses"
    print(
        f"manifest written — 1 continuous reading + {clips} ayah clips, "
        f"{total / 1e6:.0f} MB total",
    )


if __name__ == "__main__":
    main()
