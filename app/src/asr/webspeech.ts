/**
 * Web Speech API engine — the Chrome and Edge fast lane.
 *
 * Free, instant, and no download, but it exists in only two of the four browser engines
 * and streams audio to Google or Microsoft. It is an optimisation for the browsers that
 * have it, never the only path.
 *
 * This fixes four defects the prototype had, all of which are in the roadmap's list:
 * the query rebuilt itself from the whole session, `onend` restarted in a tight loop on
 * fatal errors, every error but two was swallowed silently, and a failed `start()` left
 * the state claiming to be listening while the UI read idle.
 */

import type { Engine, EngineHandlers, Utterance } from "./types";
import { tailWords } from "./types";

interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

type Constructor = new () => SpeechRecognitionLike;

function constructor(): Constructor | null {
  const scope = globalThis as unknown as {
    SpeechRecognition?: Constructor;
    webkitSpeechRecognition?: Constructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** Errors after which restarting is pointless — the engine must surface and stop. */
const FATAL = new Set(["not-allowed", "service-not-allowed", "audio-capture", "bad-grammar"]);

const MESSAGES: Record<string, string> = {
  "not-allowed": "Microphone access was denied. Allow it in your browser's site settings, then start again.",
  "service-not-allowed": "The browser blocked its speech service. Check site permissions, then start again.",
  "audio-capture": "No microphone was found. Connect one and start again.",
  network: "Speech recognition lost its network connection. Reconnecting…",
  aborted: "Recognition was interrupted. Restarting…",
  "bad-grammar": "The browser rejected the recognition settings.",
};

const MAX_BACKOFF_MS = 8000;

export class WebSpeechEngine implements Engine {
  readonly id = "webspeech";
  readonly label = "Browser speech recognition";

  private recognition: SpeechRecognitionLike | null = null;
  private handlers: EngineHandlers | null = null;
  private wantListening = false;
  private backoff = 250;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  /** Final text accumulated since the last reset, already trimmed to a rolling window. */
  private finalText = "";

  constructor(private readonly lang = "en-US") {}

  isSupported(): boolean {
    return constructor() !== null;
  }

  async start(handlers: EngineHandlers): Promise<void> {
    const Recognition = constructor();
    if (!Recognition) {
      throw new Error("This browser has no Web Speech API. Use the offline engine instead.");
    }

    this.handlers = handlers;
    this.wantListening = true;
    this.finalText = "";
    this.backoff = 250;

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = this.lang;

    // The listening flag is set here, not before start(), so a rejected start cannot
    // leave the state claiming to listen while nothing is running.
    recognition.onstart = () => {
      this.backoff = 250;
      handlers.onStatus({ kind: "listening" });
    };

    recognition.onerror = (event) => {
      const message = MESSAGES[event.error] ?? `Speech recognition failed (${event.error}).`;
      if (event.error === "no-speech") return; // routine silence, not a problem
      if (FATAL.has(event.error)) {
        this.wantListening = false;
        handlers.onStatus({ kind: "error", message });
      } else {
        handlers.onStatus({ kind: "warning", message });
      }
    };

    // Chrome ends the session periodically on its own, so a restart is normal. The
    // backoff exists for the other case: an error that recurs immediately.
    recognition.onend = () => {
      if (!this.wantListening) {
        handlers.onStatus({ kind: "stopped" });
        return;
      }
      this.restartTimer = setTimeout(() => {
        if (!this.wantListening) return;
        try {
          recognition.start();
        } catch {
          // Already starting; the next onend will try again.
        }
      }, this.backoff);
      this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF_MS);
    };

    recognition.onresult = (event) => {
      let interim = "";
      // Only the results from resultIndex forward are new. Reading from zero is what
      // made the prototype's query grow without bound.
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (!result) continue;
        const text = result[0]?.transcript ?? "";
        if (result.isFinal) this.finalText = tailWords(`${this.finalText} ${text}`);
        else interim += text;
      }
      const utterance: Utterance = {
        text: tailWords(`${this.finalText} ${interim}`.trim()),
        isFinal: interim.length === 0,
      };
      if (utterance.text) handlers.onUtterance(utterance);
    };

    this.recognition = recognition;
    try {
      recognition.start();
    } catch (error) {
      this.wantListening = false;
      this.recognition = null;
      throw new Error(
        `Could not start the microphone: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  stop(): void {
    this.wantListening = false;
    if (this.restartTimer !== null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.recognition?.stop();
    this.recognition = null;
    this.handlers?.onStatus({ kind: "stopped" });
  }
}
