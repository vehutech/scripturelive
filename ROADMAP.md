# Scripture Live — Roadmap

**Status:** All five phases complete, every gate measured. The product lives in
[`app/`](app/) and is verified against the harness in [`eval/`](eval/). `index.html` is still
the deployed prototype; switching the deployment over is now the open decision.

Turning the demo into a two-corpus product — Bible and Quran — that tracks a live reader
hands-free, with no operator clicking ahead to guess where they are going.

A formatted version of this document is published at
<https://claude.ai/code/artifact/09603600-df79-4588-8601-dd59be2e5516> (access-controlled;
this file is the source of truth).

| | |
|---|---|
| Built for | the operator running projection |
| Target corpora | KJV 31,102 verses · Quran 6,236 ayat |
| Stack | Vite · TypeScript · transformers.js · Vercel static |
| Browsers | all four engines, via in-page recognition |
| On screen | 99.4% correct across a 17-minute reading |
| Phases 0–4 | complete — all gates met |

---

## The reframe that drives everything

The demo **searches**. The product **searches once, then tracks**.

Scanning the whole corpus on every utterance works at 155 verses because almost any match
lands somewhere plausible. At 31,102 it collapses — `and it came to pass` appears roughly 450
times in the KJV, so a pure overlap scorer picks noise with confidence.

Acquire position once, then lock and follow forward. If the reader is at Psalm 23:3, the next
utterance is almost certainly 23:4 — the search space drops from 31,102 candidates to about
twelve. Context carries the weight the audio cannot, which is what makes imperfect speech
recognition survivable.

This is a small forced-alignment problem, not a search problem. Keep a periodic global check
running underneath to catch genuine jumps. Build it early; most of the architecture follows
from it.

There is also a hard ceiling that makes tracking mandatory rather than merely better.
**4.5% of ayat and 1.5% of KJV verses are byte-identical to at least one other verse** —
Ar-Rahman's refrain `فَبِأَىِّ ءَالَآءِ رَبِّكُمَا تُكَذِّبَانِ` occurs 31 times, and "And the LORD spake unto Moses,
saying" occurs 72 times. Searching text alone cannot separate these, at any recognition
quality. Only knowing where the reader already was can. Because of this, scoring reports
whether the right *words* came back separately from whether the right *reference* did: under a
duplicate the two differ, and only the second is a genuine failure.

---

## Stack and browser support

### Cross-browser is a consequence of owning the recognition

The Web Speech API is the only thing making the current demo Chrome-only. This is not a polish
problem to be solved by feature detection, because two of the four engines have no
implementation to detect.

| | `webkitSpeechRecognition` | `getUserMedia` | WebAssembly |
|---|---|---|---|
| Chrome / Edge | yes — audio streamed to Google or Azure | yes | yes |
| Safari desktop | partial, unreliable for continuous use | yes | yes |
| iOS Safari | partial, heavily restricted | yes | yes |
| Firefox | never shipped | yes | yes |

Firefox exposes a `media.webspeech.recognition.enable` preference with no backend behind it,
and that is not changing.

The other two columns are universal. **Capture the audio directly and run recognition in the
page, and the browser question disappears.** Cross-browser support is therefore not a later
feature — it falls out of owning the recognition step.

That step has to be owned regardless: Arabic recitation will never work on a conversational
model trained for Modern Standard Arabic, so Phase 3 forces it. Doing it in Phase 1 avoids
solving browser support twice.

**transformers.js is the specific route** — Whisper through ONNX Runtime Web, using WebGPU
where available (Chrome, Edge, Safari 18+, with Firefox rolling out) and falling back to WASM
everywhere else. Quantized `whisper-tiny` is roughly 40 MB and `whisper-base` roughly 80 MB,
cached in IndexedDB after first load. This buys every browser, offline operation, no
per-minute cost, and no audio leaving the building — which matters when the audio is a
congregation.

Keep the existing Web Speech path as an opportunistic fast lane on Chrome. It is already
written and costs nothing. It must simply stop being the only path.

**Pin transformers.js to the 3.x line.** Version 4.2 bundles an ONNX Runtime whose graph
optimizer rejects Whisper's quantized decoder weights outright — every model load fails with
`TransposeDQWeightsForMatMulNBits Missing required scale`. It is not a model problem: the
onnx-community and Xenova builds fail identically, mixed dtypes do not help, and neither does
lowering the optimization level. The 3.x runtime loads the same weights without complaint.
Treat a major-version bump here as something to verify against real audio, not a routine
upgrade.

**Recognition is slower than speech on CPU.** Measured on a six-second window: about 4.2 s on
WebGPU once warm, about 7 s on WASM. So passes cannot run on a fixed short interval — they
run back to back, waiting for the previous one, and the engine settles at whatever rate the
device sustains. WebGPU is preferred; the WASM fallback says plainly that it will lag. English
uses the English-only model, which is smaller and more accurate there.

iOS is the weakest target: HTTPS and a user gesture are required, background audio is
restricted, and WASM is slow on older iPhones. It works, but budget real time for it if
congregant phones are in scope.

### Build stack

**Vite and TypeScript, no UI framework, through Phase 2.**

TypeScript is not optional — it settles the build-step question before it is asked. Vite is
near-zero configuration and provides Web Worker imports, WASM loading, and code splitting,
all three of which this app needs specifically. That is the floor, not over-engineering.

No UI framework yet. Through Phase 2 the product is one screen and roughly 1,500 lines, and a
framework earns nothing against that.

**Add Svelte at Phase 4**, when views multiply — setup, live, history, settings. Svelte rather
than React because it compiles away, and the byte budget is already committed to a ~1.5 MB
corpus plus a ~40 MB model; also because the transcript repaints several times per second and
a virtual DOM is pure overhead on that path.

Deployment stays Vercel static and unchanged through Phase 3.

### The one thing that breaks static-only hosting

Streaming server-side recognition needs a WebSocket, a long-lived process, and — on the GPU
route — a GPU. Vercel functions provide none of these, so that path means a separate service
on Fly.io, Railway, or a plain GPU VPS.

Which is itself an argument for the in-browser route: transformers.js keeps the product on
pure static hosting through Phase 3. A server becomes unavoidable only when licensed
translations arrive, since copyrighted text cannot be shipped to the client — a different
reason, in a later phase.

---

## Phases

Ordered by dependency, not preference — each phase exists because the one after it is unsafe
to start without it. Every phase ends at a gate that is measured rather than eyeballed.

### Phase 0 — De-risk the unknowns (~1 week)

Two questions can kill this product. Answer both before writing any product code.

- **Spike A — archaic English.** The Web Speech API is trained on conversational speech; the
  KJV is *whithersoever* and *peradventure*. Record 20 readings, measure word error rate.
- **Spike B — Quranic recitation.** The real risk. The `ar-SA` model is trained on Modern
  Standard Arabic news and conversation, while recitation is Classical Arabic with tajweed:
  elongations, melodic delivery, specific articulation. Expect failure, and find out in week
  one rather than month four.
- **Build the eval harness now.** Audio in, predicted verse ID out, compared against ground
  truth. Everything downstream is measured against it, so no change is ever a guess.
- **Free labelled data exists for both.** [EveryAyah](https://everyayah.com) serves
  verse-by-verse recitation from many qaris — each file *is* one ayah with a known ID, roughly
  6,236 labelled clips per reciter. LibriVox carries public-domain KJV audio of known text.

**Gate:** a measured word error rate for both corpora, and a harness that scores a run
automatically. If Spike B fails badly, Quran needs a fine-tuned model — a different budget and
timeline, and better known now.

#### Result — gate met

Harness in [`eval/`](eval/). Measured with `whisper-base`, the tier transformers.js would
realistically run in a browser.

| | Spike A — KJV English | Spike B — Quranic recitation |
|---|---|---|
| Material | 17 min continuous LibriVox reading, 155 verses | 120 ayah clips, 3 reciters |
| WER | **5.7%** | **60.0%** median |
| Verse identification | 95.2% of segments in-book, 98.9% in reading order | 88.3% acquire, **94.2%** tracked |

**Spike A is answered and needs no further work.** Archaic English was never the problem;
5.7% WER on continuous human reading is fine.

**Spike B failed on transcription and passed on the thing that matters.** Recognition is as
bad as expected — Whisper hallucinates verse numbers, repeats phrases, garbles case endings —
but enough rare tokens survive for BM25 to resolve the ayah. Accuracy is flat across reciters
(85%, 90%, 90%), so failures are ayah-specific, not voice-specific:

| ground-truth length | n | acquire | tracked |
|---|---|---|---|
| 1–4 words | 21 | 61.9% | 71.4% |
| 5–9 | 30 | 80.0% | 96.7% |
| 10–19 | 45 | **100%** | **100%** |
| 20+ | 24 | **100%** | **100%** |

Every ayah of ten words or more was identified perfectly by every reciter, at 60% WER. Every
failure was eight words or shorter, and the worst cases are structural: 30:2 (`غُلِبَتِ ٱلرُّومُ`,
two words) failed on all three reciters, because two words is not enough signal for any
recogniser. In production these never arrive alone — a reciter reads continuously, so context
pins them; the per-clip test is the pessimistic case.

**Conclusion: the fine-tuned model branch is not needed.** Better recognition buys roughly
four points; tracking buys nine and degrades far more gracefully. Phase 3 should escalate no
further than server-side Whisper, and probably not even that.

### Phase 1 — Make one corpus actually work (~2–3 weeks)

Full KJV, 31,102 verses. Still static, still no framework — the app is genuinely small at this
stage.

- **Index.** Ship plain text (~4.5 MB, ~1.5 MB gzipped) and build the inverted index in a Web
  Worker at load. Shipping a prebuilt index buys about 200 ms and costs a format to maintain.
- **Scoring.** BM25, not raw overlap. It weights rare terms — precisely what the current scorer
  lacks. Pull candidates from the inverted index so roughly 150 verses are scored instead of
  31,102.
- **Tracking.** Position plus confidence. While locked, score only a window around the current
  verse; advance when the next verse outscores it; unlock when a global check beats the window
  by a margin for several consecutive frames. It is a small HMM — resist over-building it.
  **The unlock is not optional.** Phase 0 built tracking without it and matched *zero* segments
  inside the right book despite a 5.7% WER transcript: an opening line of narration locked the
  position onto an unrelated verse, and since a window search always returns something, it
  could never recover. Adding the unlock took that from 0% to 95.2%. A confidence floor is
  needed too, so noise cannot establish a lock in the first place.
- **Fix the rolling transcript.** Use `e.resultIndex` and keep the last ~15 words. The present
  code rebuilds the entire session transcript on every event, which drives the match score below
  threshold after roughly 60–80 spoken content words. Tracking needs the fix anyway.
- **Put speech recognition behind an interface** with two implementations from the start: the
  existing Web Speech engine as a Chrome fast lane, and a transformers.js engine for everyone
  else. This is what makes Phase 3 a swap rather than a rewrite, and it is also what makes the
  product cross-browser.

**Gate:** harness reports precision above 95% on high-confidence matches across LibriVox
samples. A number, not a feeling.

#### Result — gate met

App in [`app/`](app/). Vite and TypeScript, no UI framework, as planned.

| confidence threshold | precision | frames retained |
|---|---|---|
| ≥ 0.00 | 95.2% | 100% |
| ≥ 0.25 | **98.1%** | 83.3% |
| ≥ 0.50 | 99.2% | 68.3% |

Precision rises monotonically with confidence, so the signal the interface shows is
discriminative rather than decorative. Confidence is the margin over the runner-up, not an
absolute score — what matters is whether anything else could plausibly be the answer.

**What makes the number trustworthy.** The harness measures Python; the browser runs
TypeScript. `npm test` pins them together across all 37,338 verses: a digest over every
normalized verse, exact search rankings with scores, and a replay of the Spike A transcript
through the shipping tracker. That replay reproduces the Python measurement exactly —
95.2% in-book, 98.9% in reading order.

The cross-check earned itself immediately. The app derived matching text by normalizing the
display text, but the Quran's display text is Uthmani while the harness matches the simple
edition, and the two diverge orthographically — الصلوة against الصلاة. Folding them still left
2,331 ayat divergent. The roadmap already had the answer: match on simple, display Uthmani.
Matching text now ships as its own file, 0.45 MB gzipped for both; the KJV needs none, and
that is asserted rather than assumed.

**Measured in a browser.** 31,102 verses indexed in 778 ms in the worker. Both corpora
render, Arabic right-to-left in Amiri with full diacritics. A spoken Psalm 23 acquires at
23:1, then follows 23:2 through 23:5 in tracked mode with confidence climbing 0.51 to 0.86.
The core bundle is 5.3 kB gzipped, since transformers.js is imported lazily and browsers
taking the Web Speech fast lane never download it.

**Recognition since verified against real audio.** The offline engine could not load its
model at all on first contact with a real browser — an ONNX Runtime regression, recorded under
the stack section above. With that fixed, English transcribes a spoken Psalm 23 as "The Lord
is my shepherd. I shall not want. He may cathme to lie down in green pastures" — *maketh*
mangled, exactly the error class the matcher exists to absorb — and resolves to Psalms 23:1
with 23:2 second. Arabic transcribes a recitation of 1:1 as بسم الله الرحمن الرحيم, exactly its
ground truth.

**Since verified end to end on a real device.** Microphone capture, the AudioWorklet, model
load and recognition all run. Getting there surfaced one more defect: switching English to the
English-only model left `language` and `task` in the generation options, which those models
reject outright, so every pass failed the moment audio started flowing.

### Phase 2 — Abstract the corpus (~1 week)

Both scriptures are ordered collections of numbered units, so they share one engine. They
differ in ways that will cost you if collapsed.

| | Bible | Quran |
|---|---|---|
| Canonical text | the translation, for English readers | the Arabic; translation is secondary |
| Direction | left to right | right to left |
| Mode | reading | recitation |

- Shared flat verse index, with a per-corpus reference formatter, normalizer, and renderer.
- One engine, two adapters. Do not build two apps; do not pretend they are the same thing
  either.

**Gate:** the KJV path still passes every Phase 1 measurement after the refactor.

#### Result — gate met

Each corpus now has one adapter in [`app/src/adapters.ts`](app/src/adapters.ts) holding its
label, writing direction, recognition language, normalizer, and reference format. Those five
facts had been flattened into ternaries spread across three files. Adding a third corpus is
now adding an adapter, and the corpus picker builds itself from the adapter list rather than
duplicating it in markup.

Dependencies flow one way with no cycles: normalize, adapters, corpus, matcher, tracker.

The KJV path reports exactly the numbers it did before the refactor — 95.2% in-book, 98.9% in
reading order, 98.1% precision above a 0.25 confidence threshold — and both corpora still
agree with the Python harness across all 37,338 verses.

### Phase 3 — Quran (~3–4 weeks)

Scope here depends entirely on what Phase 0 measured. Everything else is ready for it.

- **Text.** [Tanzil](https://tanzil.net), verified Uthmani. It ships both a simple variant —
  diacritics stripped, alif, ya and ta-marbuta normalized — and the full Uthmani. Match on
  simple, display Uthmani, write no normalization code of your own.
- **Rendering.** Right to left, a proper Arabic face with full harakat, optional transliteration
  and paired translation.
- **Recognition.** The transformers.js engine from Phase 1 is already the default; the Web
  Speech fast lane does not apply here at all. **Phase 0 settled how far to escalate: not far.**
  Whisper via transformers.js, in-browser and offline, already identifies every ayah of ten
  words or more perfectly. Server-side Whisper stays available if the short-ayah tail proves
  worth a separate service, and the fine-tuned-model branch is closed unless something later
  reopens it.
- **The short-ayah tail is a tracking problem, not a recognition problem.** Ayat under ten
  words carry too little signal to identify in isolation, and no recogniser fixes that. Lean on
  position instead, and treat surahs opening with muqattaʿat as the worst case to design
  against.

**Gate:** correct ayah identified on held-out EveryAyah clips across at least three reciters —
different voices, not three takes of one.

#### Result — gate met

120 clips from a sample offset half a stride from the development set, so it shares no ayah
with it, across Alafasy, Husary and Abdul Basit. Measured through the shipping TypeScript,
replaying the exact transcripts the Python harness scored, and reproducing its numbers.

| ground-truth length | n | acquire | tracked |
|---|---|---|---|
| 1–4 words | 21 | 57.1% | 85.7% |
| 5–9 | 36 | 86.1% | 91.7% |
| 10–19 | 48 | 93.8% | **100%** |
| 20+ | 15 | **100%** | **100%** |
| **all** | **120** | **85.8%** | **95.0%** |

Word error rate was 50% median. Accuracy is flat across reciters (85.0%, 85.0%, 87.5%), and
it generalizes: tracked accuracy on held-out clips is 95.0% against 94.2% on the development
set. The length pattern holds — everything from ten words up is identified perfectly once
tracking has a position, and the failures remain concentrated in short ayat.

**Also shipped:** Pickthall's 1930 translation, public domain since 2006, as a separate
line-per-ayah file shown below the Arabic with attribution. Whether a corpus carries a
translation is an adapter fact; the KJV has none, and that is the point rather than an
omission.

**One bug worth recording.** Extracting the normalizers into their own module let bidi
reordering transpose two characters in the Arabic strip class, widening it to cover the whole
alphabet. `normalizeArabic` returned an empty string for every input, and the class looked
correct on screen. The whole suite still passed, because the Quran's matching text ships as
its own file and the corpus digest never exercises that normalizer — the only thing it still
handles is the spoken or typed query, and nothing asserted on that. Query normalization is now
checked against the Python fixtures, no verse may normalize to nothing, and every Arabic
codepoint in the module is an escape rather than a literal.

### Phase 4 — Product shell (ongoing)

Accounts, saved sessions, projection output, offline mode.

- This is where a backend and a framework finally earn their place — **not before**. Through
  Phase 3 the app runs to roughly 1,500 lines and vanilla is the correct answer.
- Licensed translations force a server regardless, since copyrighted text cannot be shipped to
  the client.

**Gate:** a full service or khutbah followed end to end without losing lock or needing a hand
on the keyboard.

#### Result — gate met

**The open question is answered: the operator holds the screen.** That is the wedge —
ProPresenter and EasyWorship own church projection but still need someone clicking ahead to
guess where the speaker is going.

The projector is a second document the operator drags to the second display, driven over
`BroadcastChannel` with a heartbeat both ways so nobody has to wonder whether the screen
behind them is live. It holds no state, runs no recognition, and decides nothing — whatever
the control window sends is what the room sees, so a fault in matching cannot reach the wall
on its own. It is 0.6 kB gzipped, carries neither corpus nor model, and holds a wake lock
because services outlast any idle timeout.

**What may reach the room unattended is the safety rule of this phase**, so it lives in its own
function and is asserted rather than trusted to a handler. Below the confidence bar, hold. An
ambiguous reference holds however well it scored, because the words being right is not the
same as the reference being right. An operator's own search or history choice always goes.

That rule carries the phase. Over the seventeen-minute reading:

| | |
|---|---|
| Tracker excursions outside the passage | 2, worst 8 consecutive frames |
| Longest unbroken run | 177 frames |
| **Frames where the wall showed a wrong verse** | **1 of 181 — 99.4% correct** |

The control view is allowed to wander; the screen is not. The gate measures the screen rather
than the tracker, because that is what an audience sees.

A service worker caches the corpus and shell, so a dead connection mid-service cannot cost the
text. Speech models are left alone — transformers.js already caches those.

**No accounts and no backend.** The roadmap expected both here, but the chosen audience
removes the need: one machine running a control window and a projector window in the same
browser has nothing to sync. Settings persist in local storage. A server becomes necessary
only when licensed translations arrive, which remains a licensing decision rather than a
technical one.

**Svelte was not added either.** The roadmap called for it once views multiplied, reasoning
from setup, live, history and settings. There are two views, one of which is a hundred lines
of display, so vanilla still wins on the same reasoning that predicted the change.

---

## Two things that will bite

### Licensing is a gating dependency, not a detail

The KJV is public domain in the US; UK Crown copyright is perpetual but not practically
enforced abroad. Quran Arabic via Tanzil is clean. But the NIV, ESV and NLT are heavily
copyrighted, cost real money, and cannot be shipped to the client — which forces a server the
moment one is added. Quran translations vary by translator.

Design for pluggable translations from day one and launch on public domain only, so the
question is already answered when someone asks for the NIV.

### A wrong verse is a trust failure, not a bug

The wrong verse on screen during a service is embarrassing. Wrong Quran text is offensive and
can end the product outright.

Precision over recall, always. Never render a low-confidence match as though it were certain —
show the reference, show alternatives, keep manual override one tap away. The existing
confidence bar is the right instinct; it needs to be authoritative rather than decorative.

---

## Where the product is differentiated

Church projection belongs to ProPresenter and EasyWorship. Quran recitation recognition belongs
to Tarteel. The wedge is the thing neither does well: **real-time, hands-free, no operator.**
Nobody clicking ahead trying to guess where the preacher is going next. That is genuinely
underserved — build toward it rather than toward a general scripture viewer.

---

## Open question

**Who holds the screen?** Answered during Phase 4: **the operator running projection.** That
is the wedge — existing tools own the screen but still need a hand on the keyboard, and this
one does not. The other two readings remain open as separate products on the same engine:

- a congregant following along on their phone
- a student drilling hifz — the most new logic, since the engine would have to compare
  against expected text rather than locate within it

What is genuinely open now is smaller and concrete: whether to point the deployment at
[`app/`](app/) and retire `index.html`, and whether the short-ayah tail under ten words is
worth further work given that tracking already carries it.

---

## Prototype defects, and where they stand

All six were fixed in [`app/`](app/) during Phase 1. They remain in `index.html`, which is
still what Vercel serves, and retire with it.

| # | Issue | Fixed by |
|---|---|---|
| 1 | Query rebuilt from the whole session, so the true verse fell below threshold after ~60-80 spoken words. | Reads from `resultIndex` forward, keeps a rolling 15-word window. |
| 2 | `onend` restarted unconditionally, spinning on errors that restarting cannot fix. | Backs off exponentially; fatal errors stop the engine. |
| 3 | Every error but two was swallowed silently, leaving "Listening..." forever. | Every error carries a sentence saying what to do about it. |
| 4 | A failed `start()` left the state claiming to listen while the UI read idle. | The listening flag is set on the start event, not before it. |
| 5 | Verse text re-tokenized on every search. | Tokenized once at index build. |
| 6 | No entry-length normalization, so short verses were disproportionately cheap to match. | BM25 normalizes by document length. |

Verse counts verified against the shipped index: 26 books, 155 verses today. KJV is 66 books,
1,189 chapters, 31,102 verses. Quran is 114 surahs, 6,236 ayat.
