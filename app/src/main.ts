/**
 * Interface wiring.
 *
 * The one rule that shapes this file: a match is never presented as more certain than it
 * is. Phase 0 measured confidence rising monotonically with precision — 95.2% overall,
 * 98.1% above a 0.25 threshold, 99.2% above 0.5 — so the signal is worth showing. A wrong
 * verse on a screen during a service is a trust failure, not a cosmetic bug, so anything
 * uncertain says so, alternatives stay one tap away, and typing a verse always wins.
 */

import { ADAPTERS, CORPORA, adapterFor, type CorpusAdapter, type CorpusName } from "./adapters";
import type { TrackResult } from "./tracker";
import type { FromWorker, ToWorker } from "./search.worker";
import type { Engine, EngineStatus } from "./asr/types";
import { WebSpeechEngine } from "./asr/webspeech";
import { WhisperEngine } from "./asr/whisper";
import { Channel, shouldAutoProject, type ProjectedVerse } from "./channel";

/** Below this the match is shown as a guess rather than an answer. */
const GUESS_BELOW = 0.25;
/** Between that and this it is shown, but marked uncertain. */
const UNCERTAIN_BELOW = 0.5;

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const ui = {
  corpus: el<HTMLSelectElement>("corpus"),
  engine: el<HTMLSelectElement>("engine"),
  ring: el("ring"),
  mic: el<HTMLButtonElement>("mic"),
  status: el("status"),
  progress: el("progress"),
  progressBar: el("progressBar"),
  transcript: el("transcript"),
  verse: el("verse"),
  ref: el("ref"),
  dot: el("dot"),
  meta: el("meta"),
  text: el("text"),
  translation: el<HTMLParagraphElement>("translation"),
  notice: el<HTMLParagraphElement>("notice"),
  alts: el("alts"),
  altList: el("altList"),
  manual: el<HTMLFormElement>("manual"),
  query: el<HTMLInputElement>("query"),
  history: el("history"),
  footer: el("footer"),
  openProjector: el<HTMLButtonElement>("openProjector"),
  projDot: el("projDot"),
  projLabel: el("projLabel"),
  autoSend: el<HTMLInputElement>("autoSend"),
  sendNow: el<HTMLButtonElement>("sendNow"),
  blackout: el<HTMLButtonElement>("blackout"),
};

const worker = new Worker(new URL("./search.worker.ts", import.meta.url), {
  type: "module",
});

let adapter: CorpusAdapter = adapterFor("kjv");
let translationLabel: string | null = null;

// --------------------------------------------------------------------------- //
// Projection
// --------------------------------------------------------------------------- //

/**
 * Operator settings, remembered between services.
 *
 * Local only, and deliberately so. The chosen audience is one machine running a control
 * window and a projector window in the same browser, which needs no account and no
 * server to sync against. Storage can throw outright in a private window, so every access
 * is guarded and a failure just means the defaults.
 */
const SETTINGS_KEY = "scripture-live:settings";

interface Settings {
  corpus: CorpusName;
  engineId: string;
  autoSend: boolean;
}

function loadSettings(): Partial<Settings> {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>;
  } catch {
    return {};
  }
}

function saveSettings(): void {
  try {
    localStorage.setItem(
      SETTINGS_KEY,
      JSON.stringify({
        corpus: adapter.name,
        engineId: ui.engine.value,
        autoSend: ui.autoSend.checked,
      } satisfies Settings),
    );
  } catch {
    // Remembering settings is a convenience, never a requirement.
  }
}

const saved = loadSettings();

const projection = new Channel("control");
/** The verse currently on the projected screen, so a reconnecting projector can catch up. */
let projected: ProjectedVerse | null = null;
/** The verse the control view is showing, which may not be what the room sees. */
let candidate: ProjectedVerse | null = null;
let projectorWindow: Window | null = null;

/**
 * A match only reaches the room on its own if it clears the confidence bar. Anything
 * below it stays in the control view for the operator to send by hand — the whole point
 * of the threshold is that a wrong verse never appears behind the speaker unattended.
 */
function considerForProjection(
  verse: ProjectedVerse,
  confidence: number | undefined,
  ambiguousReference: boolean,
): void {
  candidate = verse;
  ui.sendNow.disabled = !projection.peerConnected;
  if (
    shouldAutoProject({
      confidence,
      ambiguousReference,
      autoSend: ui.autoSend.checked,
      threshold: UNCERTAIN_BELOW,
    })
  ) {
    sendToProjection(verse);
  }
}

function sendToProjection(verse: ProjectedVerse): void {
  projected = verse;
  projection.send({ kind: "verse", verse });
  ui.blackout.disabled = !projection.peerConnected;
}

function blackout(): void {
  projected = null;
  projection.send({ kind: "blank" });
  ui.blackout.disabled = true;
}

function setProjectorState(connected: boolean): void {
  ui.projDot.classList.toggle("live", connected);
  ui.projLabel.textContent = connected ? "Projector live" : "No projector";
  ui.sendNow.disabled = !connected || candidate === null;
  ui.blackout.disabled = !connected || projected === null;
}

projection.onPeer(setProjectorState);
// A projector opened mid-service asks what should already be showing.
projection.onRequest(() => {
  projection.send(projected ? { kind: "verse", verse: projected } : { kind: "blank" });
});

ui.openProjector.addEventListener("click", () => {
  projectorWindow = window.open(
    "/projector.html",
    "scripture-live-projector",
    "width=1280,height=720",
  );
  if (!projectorWindow) {
    setStatus(
      "The projector window was blocked. Allow pop-ups for this site, then try again.",
      "bad",
    );
    return;
  }
  projectorWindow.focus();
});

ui.sendNow.addEventListener("click", () => {
  if (candidate) sendToProjection(candidate);
});

ui.blackout.addEventListener("click", blackout);
let ready = false;
let listening = false;
let engine: Engine | null = null;
const history: { ref: string; text: string }[] = [];

// --------------------------------------------------------------------------- //
// Engines
// --------------------------------------------------------------------------- //

function buildEngines(): { engine: Engine; supported: boolean }[] {
  const language = adapter.recognitionLanguage;
  const webSpeech = new WebSpeechEngine(language === "ar" ? "ar-SA" : "en-US");
  const whisper = new WhisperEngine("tiny", language);
  return [
    { engine: whisper, supported: whisper.isSupported() },
    { engine: webSpeech, supported: webSpeech.isSupported() },
  ];
}

function populateEngines(): void {
  const options = buildEngines();
  ui.engine.innerHTML = "";
  for (const { engine: candidate, supported } of options) {
    const option = document.createElement("option");
    option.value = candidate.id;
    option.textContent = supported
      ? candidate.label
      : `${candidate.label} — unavailable here`;
    option.disabled = !supported;
    ui.engine.append(option);
  }
  // Prefer the browser's own engine where it exists: it is instant and needs no
  // download. Whisper is the fallback that makes every other browser work.
  const webSpeech = options.find((o) => o.engine.id === "webspeech");
  const first = options.find((o) => o.supported);
  ui.engine.value = (webSpeech?.supported ? webSpeech : first)?.engine.id ?? "";
  updateFooter();
}

function currentEngine(): Engine {
  const chosen = buildEngines().find((o) => o.engine.id === ui.engine.value);
  if (!chosen?.supported) throw new Error("That recognition engine is not available here.");
  return chosen.engine;
}

function updateFooter(): void {
  const selected = ui.engine.selectedOptions[0]?.textContent ?? "";
  ui.footer.textContent = selected.includes("Offline")
    ? "Recognition runs entirely in this browser. No audio leaves your device."
    : "Recognition uses your browser's speech service, which sends audio to its provider.";
}

// --------------------------------------------------------------------------- //
// Status
// --------------------------------------------------------------------------- //

function setStatus(message: string, tone: "" | "listening" | "good" | "warn" | "bad" = ""): void {
  ui.status.textContent = message;
  ui.status.className = `status${tone ? ` ${tone}` : ""}`;
}

function onEngineStatus(status: EngineStatus): void {
  switch (status.kind) {
    case "loading":
      ui.progress.hidden = false;
      ui.progressBar.style.width = `${Math.round((status.progress ?? 0) * 100)}%`;
      setStatus(status.detail);
      return;
    case "listening":
      ui.progress.hidden = true;
      listening = true;
      ui.ring.classList.add("listening");
      ui.mic.classList.add("active");
      ui.mic.setAttribute("aria-label", "Stop listening");
      setStatus("Listening", "listening");
      return;
    case "stopped":
      ui.progress.hidden = true;
      stopVisuals();
      setStatus("Tap the microphone to begin");
      return;
    case "warning":
      setStatus(status.message, "warn");
      return;
    case "error":
      ui.progress.hidden = true;
      stopVisuals();
      setStatus(status.message, "bad");
      return;
    case "idle":
      return;
  }
}

function stopVisuals(): void {
  listening = false;
  ui.ring.classList.remove("listening");
  ui.mic.classList.remove("active");
  ui.mic.setAttribute("aria-label", "Start listening");
}

// --------------------------------------------------------------------------- //
// Rendering
// --------------------------------------------------------------------------- //

function showVerse(
  ref: string,
  text: string,
  options: {
    confidence?: number;
    ambiguous?: boolean;
    tracked?: boolean;
    source?: string;
    translation?: string | undefined;
  } = {},
): void {
  const { confidence, ambiguous = false, tracked = false, source, translation } = options;

  ui.ref.textContent = ref;
  ui.text.textContent = text;
  ui.text.setAttribute("dir", adapter.direction);
  ui.verse.classList.add("visible");

  // Shown beside the canonical text, never in place of it.
  if (translation) {
    ui.translation.hidden = false;
    ui.translation.textContent = translation;
    if (translationLabel) {
      const note = document.createElement("span");
      note.className = "attribution";
      note.textContent = translationLabel;
      ui.translation.append(note);
    }
  } else {
    ui.translation.hidden = true;
    ui.translation.textContent = "";
  }

  ui.verse.classList.toggle("uncertain", confidence !== undefined && confidence < UNCERTAIN_BELOW);
  ui.verse.classList.toggle("guess", confidence !== undefined && confidence < GUESS_BELOW);

  if (confidence === undefined) {
    ui.dot.className = "dot";
    ui.meta.textContent = source ?? "";
    ui.notice.hidden = true;
  } else {
    const certain = confidence >= UNCERTAIN_BELOW;
    ui.dot.className = `dot${certain ? "" : confidence >= GUESS_BELOW ? " warn" : " bad"}`;
    ui.meta.textContent = `${certain ? "Confident" : confidence >= GUESS_BELOW ? "Uncertain" : "Best guess"} · ${tracked ? "following" : "searched"}`;

    if (ambiguous) {
      ui.notice.hidden = false;
      ui.notice.textContent =
        "These exact words appear in more than one place. The text is right; the reference may not be.";
    } else if (!certain) {
      ui.notice.hidden = false;
      ui.notice.textContent =
        "Low confidence — keep speaking, or type the words below to choose directly.";
    } else {
      ui.notice.hidden = true;
    }
  }

  considerForProjection(
    {
      ref,
      text,
      direction: adapter.direction,
      corpus: adapter.name,
      ...(translation ? { translation } : {}),
    },
    confidence,
    ambiguous,
  );

  if (!history.some((entry) => entry.ref === ref)) {
    history.unshift({ ref, text });
    if (history.length > 8) history.pop();
    renderHistory();
  }
}

function renderAlternatives(hits: { ref: string; text: string; translation?: string }[]): void {
  ui.altList.innerHTML = "";
  if (hits.length === 0) {
    ui.alts.classList.remove("visible");
    return;
  }
  for (const hit of hits) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "alt";
    button.innerHTML = `<span class="r"></span><span class="t"></span>`;
    button.querySelector(".r")!.textContent = hit.ref;
    const body = button.querySelector<HTMLElement>(".t")!;
    body.textContent = hit.text;
    // Arabic alternatives must read right-to-left like the verse itself.
    body.setAttribute("dir", adapter.direction);
    button.addEventListener("click", () => {
      showVerse(hit.ref, hit.text, { source: "Chosen by hand", translation: hit.translation });
      ui.alts.classList.remove("visible");
    });
    ui.altList.append(button);
  }
  ui.alts.classList.add("visible");
}

function renderHistory(): void {
  ui.history.classList.add("visible");
  ui.history.innerHTML = "";
  for (const entry of history) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hist";
    button.innerHTML = `<span class="r"></span><span class="t"></span>`;
    button.querySelector(".r")!.textContent = entry.ref;
    button.querySelector(".t")!.textContent = entry.text;
    button.addEventListener("click", () => {
      showVerse(entry.ref, entry.text, { source: "From history" });
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    ui.history.append(button);
  }
}

// --------------------------------------------------------------------------- //
// Worker
// --------------------------------------------------------------------------- //

const send = (message: ToWorker) => worker.postMessage(message);

worker.onmessage = (event: MessageEvent<FromWorker>) => {
  const message = event.data;
  switch (message.type) {
    case "progress":
      setStatus(`${message.detail}…`);
      return;

    case "ready":
      ready = true;
      translationLabel = message.translation;
      ui.mic.disabled = false;
      ui.corpus.disabled = false;
      setStatus("Tap the microphone to begin");
      ui.footer.dataset["counts"] =
        `${message.verseCount.toLocaleString()} verses · indexed in ${message.ms} ms`;
      return;

    case "result": {
      const result = message.result as TrackResult | null;
      if (!result) return;
      showVerse(result.verse.ref, result.verse.text, {
        confidence: result.confidence,
        ambiguous: result.ambiguousReference,
        tracked: result.tracked,
        translation: result.verse.translation,
      });
      // Below the guess threshold the alternatives matter more than the answer.
      if (result.confidence < GUESS_BELOW || result.ambiguousReference) {
        send({ type: "search", text: lastHeard, topK: 4, reason: "alternatives" });
      } else {
        ui.alts.classList.remove("visible");
      }
      return;
    }

    case "hits": {
      if (message.reason === "manual") {
        const [best, ...rest] = message.hits;
        if (best) {
          showVerse(best.ref, best.text, { source: "Found by search", translation: best.translation });
          renderAlternatives(rest.slice(0, 4));
        } else {
          setStatus("Nothing matched those words.", "warn");
        }
      } else {
        renderAlternatives(message.hits.slice(0, 4));
      }
      return;
    }

    case "failed":
      setStatus(message.message, "bad");
      return;
  }
};

// --------------------------------------------------------------------------- //
// Interaction
// --------------------------------------------------------------------------- //

let lastHeard = "";

ui.mic.addEventListener("click", async () => {
  if (!ready) return;
  if (listening) {
    engine?.stop();
    engine = null;
    return;
  }
  try {
    engine = currentEngine();
    ui.engine.disabled = true;
    await engine.start({
      onStatus: onEngineStatus,
      onUtterance: (utterance) => {
        lastHeard = utterance.text;
        ui.transcript.textContent = utterance.text;
        send({ type: "feed", text: utterance.text });
      },
    });
  } catch (error) {
    engine = null;
    ui.engine.disabled = false;
    stopVisuals();
    ui.progress.hidden = true;
    setStatus(error instanceof Error ? error.message : String(error), "bad");
  }
});

ui.corpus.addEventListener("change", () => {
  engine?.stop();
  engine = null;
  ready = false;
  adapter = adapterFor(ui.corpus.value as CorpusName);
  saveSettings();
  history.length = 0;
  ui.history.classList.remove("visible");
  ui.verse.classList.remove("visible");
  ui.mic.disabled = true;
  ui.corpus.disabled = true;
  ui.engine.disabled = false;
  ui.transcript.innerHTML = '<span class="hint">Spoken words appear here.</span>';
  populateEngines();
  send({ type: "load", corpus: adapter.name });
});

ui.engine.addEventListener("change", () => {
  updateFooter();
  saveSettings();
});
ui.autoSend.addEventListener("change", saveSettings);

ui.manual.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = ui.query.value.trim();
  if (!query || !ready) return;
  // Typing is an override: it must not move the tracked position.
  send({ type: "search", text: query, topK: 5, reason: "manual" });
  setStatus("Searched by hand", "good");
});

function populateCorpora(): void {
  ui.corpus.innerHTML = "";
  for (const option of CORPORA) {
    const node = document.createElement("option");
    node.value = option.name;
    node.textContent = option.label;
    ui.corpus.append(node);
  }
  ui.corpus.value = adapter.name;
}

// Registered only in a built app: in dev the worker would serve stale modules and make
// every edit look like it did not apply.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      // Offline support is a convenience; failing to register must not break the app.
    });
  });
}

if (saved.corpus && saved.corpus in ADAPTERS) adapter = adapterFor(saved.corpus);
if (saved.autoSend !== undefined) ui.autoSend.checked = saved.autoSend;

populateCorpora();
populateEngines();
// Restore the engine only if it is still available in this browser.
if (saved.engineId) {
  const option = [...ui.engine.options].find((o) => o.value === saved.engineId && !o.disabled);
  if (option) {
    ui.engine.value = saved.engineId;
    updateFooter();
  }
}
send({ type: "load", corpus: adapter.name });
