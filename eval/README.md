# Evaluation harness

Phase 0 of the [roadmap](../ROADMAP.md). Audio in, verse id out, scored automatically,
so no later change to the matcher or the recognition backend is ever a guess.

## Setup

```bash
python3 -m venv .venv
./.venv/bin/pip install faster-whisper jiwer
./.venv/bin/python corpus.py       # fetch KJV + Quran, ~15 MB
./.venv/bin/python fetch_audio.py  # fetch labelled audio, ~63 MB
```

Everything lands in `data/`, which is gitignored — the scripts are the source of truth.

## Run

```bash
./.venv/bin/python evaluate.py --spike B --limit 6   # smoke test
./.venv/bin/python evaluate.py --spike B             # 120 ayah clips, 3 reciters
./.venv/bin/python evaluate.py --spike A             # continuous KJV reading
```

`--model tiny|base|small` selects the Whisper size. `base` is the tier that matches
what transformers.js would realistically run in a browser.

## What each file does

| File | Responsibility |
|---|---|
| `corpus.py` | Fetches and normalizes both corpora. Owns the Arabic and English normalizers. |
| `fetch_audio.py` | Downloads the labelled audio and writes `data/manifest.json`. |
| `matcher.py` | Inverted index and BM25, with both an acquire mode and a tracking mode. |
| `evaluate.py` | Runs a spike end to end and reports WER, top-1, and top-5. |

Each has a self-check that runs when the file is executed directly.

## Data sources

- **KJV text** — [aruljohn/Bible-kjv](https://github.com/aruljohn/Bible-kjv), public domain.
- **Quran text** — [fawazahmed0/quran-api](https://github.com/fawazahmed0/quran-api),
  Tanzil-derived, both simple and Uthmani editions.
- **English audio** — LibriVox reading of Ephesians, public domain, 155 verses read
  continuously.
- **Arabic audio** — [EveryAyah](https://everyayah.com), per-ayah clips from Alafasy,
  Husary, and Abdul Basit.

## Two things worth knowing about the data

**The basmala is prepended to the wrong ayah.** Both Quran APIs glue
`بسم الله الرحمن الرحيم` onto the first ayah of every surah except Al-Fatiha (where it
genuinely is ayah 1) and At-Tawbah (which has none). Left alone, every surah-opening
clip would mismatch its own ground truth. `corpus.py` strips it and asserts the fix held.

**Metrics are computed on normalized text.** Arabic WER is measured after diacritics
are stripped and alif, ya, and ta-marbuta are folded, because predicting harakat is
irrelevant to identifying an ayah. English is lowercased with punctuation removed, since
recognition emits neither.
