/**
 * Whisper via transformers.js — the engine that works everywhere.
 *
 * Captures audio directly with getUserMedia and runs recognition in the page, which is
 * what makes the product cross-browser: Firefox has never shipped the Web Speech API and
 * Safari's is unreliable for continuous use, but getUserMedia and WebAssembly are
 * universal. It also keeps the audio in the building, which matters when the audio is a
 * congregation.
 *
 * The model is fetched once and cached by the browser thereafter. transformers.js uses
 * WebGPU where available and falls back to WASM.
 */

import type { Engine, EngineHandlers } from "./types";

/** Whisper expects mono 16 kHz. */
const SAMPLE_RATE = 16000;
/** How much trailing audio each pass transcribes. */
const WINDOW_SECONDS = 6;
/**
 * Shortest gap between passes. Measured on this machine, a 6-second window takes about
 * 4.2 s on WebGPU once warm and about 7 s on WASM, so a fixed short interval would just
 * queue work that never drains. The real gap is whichever is longer, this floor or the
 * last pass — see `schedule`.
 */
const MIN_HOP_MS = 1500;
/** Leave this much headroom over the last pass, so passes never pile up. */
const HOP_HEADROOM = 1.15;

/**
 * English uses the English-only model: it is smaller, more accurate on English, and the
 * multilingual one is only needed when the corpus is not English.
 */
const MODELS = {
  tiny: { en: "Xenova/whisper-tiny.en", multilingual: "Xenova/whisper-tiny" },
  base: { en: "Xenova/whisper-base.en", multilingual: "Xenova/whisper-base" },
} as const;

export type WhisperSize = keyof typeof MODELS;

/**
 * Posts raw mono samples back to the main thread. Inlined as a blob so the worklet needs
 * no separate build entry.
 */
const WORKLET_SOURCE = `
class Recorder extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel && channel.length) this.port.postMessage(channel.slice(0));
    return true;
  }
}
registerProcessor('recorder', Recorder);
`;

export class WhisperEngine implements Engine {
  readonly id: string;
  readonly label = "Offline speech recognition";

  private transcriber: ((audio: Float32Array, options: object) => Promise<{ text: string }>) | null =
    null;
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private worklet: AudioWorkletNode | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backend: "webgpu" | "wasm" | null = null;
  /**
   * English-only models reject `language` and `task` outright rather than ignoring them,
   * so the generation options depend on which model actually loaded.
   */
  private multilingual = false;
  /** Duration of the last pass, used to pace the next one. */
  private lastPassMs = MIN_HOP_MS;
  /** Rolling buffer of the most recent WINDOW_SECONDS of audio. */
  private buffer = new Float32Array(SAMPLE_RATE * WINDOW_SECONDS);
  private filled = 0;
  private running = false;
  private busy = false;
  private lastText = "";

  constructor(
    private readonly size: WhisperSize = "tiny",
    private readonly language = "en",
  ) {
    this.id = `whisper-${size}`;
  }

  isSupported(): boolean {
    return (
      typeof AudioWorkletNode !== "undefined" &&
      typeof navigator !== "undefined" &&
      navigator.mediaDevices?.getUserMedia !== undefined
    );
  }

  private append(samples: Float32Array): void {
    if (samples.length >= this.buffer.length) {
      this.buffer.set(samples.subarray(samples.length - this.buffer.length));
      this.filled = this.buffer.length;
      return;
    }
    const keep = this.buffer.length - samples.length;
    this.buffer.copyWithin(0, this.buffer.length - keep);
    this.buffer.set(samples, keep);
    this.filled = Math.min(this.buffer.length, this.filled + samples.length);
  }

  async start(handlers: EngineHandlers): Promise<void> {
    if (!this.isSupported()) {
      throw new Error(
        "This browser cannot capture audio. It needs a secure (https) page and microphone support.",
      );
    }

    handlers.onStatus({
      kind: "loading",
      detail: `Loading the ${this.size} speech model. This happens once, then it is cached.`,
    });

    // Imported lazily so browsers using the Web Speech fast lane never download it.
    const { pipeline } = await import("@huggingface/transformers");
    this.multilingual = this.language !== "en";
    const model = this.multilingual
      ? MODELS[this.size].multilingual
      : MODELS[this.size].en;

    const progress_callback = (event: { status?: string; progress?: number }) => {
      if (event.status === "progress" && typeof event.progress === "number") {
        handlers.onStatus({
          kind: "loading",
          detail: `Loading the ${this.size} speech model`,
          progress: event.progress / 100,
        });
      }
    };

    // WebGPU runs a 6-second window at about 0.8x realtime once warm; WASM runs it at
    // about 1.3x, which cannot keep up with continuous speech. Prefer the GPU and fall
    // back rather than fail, since WASM still works for short bursts and manual use.
    let transcriber: unknown;
    try {
      if (!("gpu" in navigator)) throw new Error("no WebGPU");
      transcriber = await pipeline("automatic-speech-recognition", model, {
        device: "webgpu",
        dtype: "fp32",
        progress_callback,
      });
      this.backend = "webgpu";
    } catch {
      transcriber = await pipeline("automatic-speech-recognition", model, {
        device: "wasm",
        progress_callback,
      });
      this.backend = "wasm";
      handlers.onStatus({
        kind: "warning",
        message:
          "Running on CPU — this browser has no GPU acceleration, so recognition will lag behind speech.",
      });
    }
    this.transcriber = transcriber as typeof this.transcriber;

    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      throw new Error(
        name === "NotAllowedError"
          ? "Microphone access was denied. Allow it in your browser's site settings, then start again."
          : name === "NotFoundError"
            ? "No microphone was found. Connect one and start again."
            : `Could not open the microphone: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await this.context.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    this.worklet = new AudioWorkletNode(this.context, "recorder");
    this.worklet.port.onmessage = (event: MessageEvent<Float32Array>) =>
      this.append(event.data);
    this.context.createMediaStreamSource(this.stream).connect(this.worklet);

    this.running = true;
    this.filled = 0;
    this.lastText = "";
    this.schedule(handlers);
    handlers.onStatus({ kind: "listening" });
  }

  /**
   * Run passes back to back rather than on a fixed interval.
   *
   * A fixed interval shorter than a pass just queues work that never drains. Waiting for
   * the previous pass and adding headroom keeps the engine at whatever rate the device
   * can actually sustain.
   */
  private schedule(handlers: EngineHandlers): void {
    if (!this.running) return;
    const delay = Math.max(MIN_HOP_MS, this.lastPassMs * HOP_HEADROOM);
    this.timer = setTimeout(async () => {
      await this.pass(handlers);
      this.schedule(handlers);
    }, delay);
  }

  /** Transcribe the current window, skipping if a previous pass is still running. */
  private async pass(handlers: EngineHandlers): Promise<void> {
    if (!this.running || this.busy || !this.transcriber) return;
    // Below roughly a second there is nothing worth sending.
    if (this.filled < SAMPLE_RATE) return;

    this.busy = true;
    const started = performance.now();
    try {
      const audio = this.buffer.slice(this.buffer.length - this.filled);
      const output = await this.transcriber(audio, {
        return_timestamps: false,
        ...(this.multilingual ? { language: this.language, task: "transcribe" } : {}),
      });
      const text = (output.text ?? "").trim();
      // Overlapping windows re-transcribe the same speech, so only changes are worth
      // emitting; the matcher would otherwise see the same words repeatedly.
      if (text && text !== this.lastText) {
        this.lastText = text;
        handlers.onUtterance({ text, isFinal: true });
      }
    } catch (error) {
      handlers.onStatus({
        kind: "warning",
        message: `A recognition pass failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      this.lastPassMs = performance.now() - started;
      this.busy = false;
    }
  }

  /** Which backend actually loaded, once start() has resolved. */
  get acceleration(): "webgpu" | "wasm" | null {
    return this.backend;
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.worklet?.port.close();
    this.worklet?.disconnect();
    this.worklet = null;
    void this.context?.close();
    this.context = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    this.filled = 0;
  }
}
