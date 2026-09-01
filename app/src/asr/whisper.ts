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
/** How often a pass runs. Shorter than the window, so passes overlap and words survive
 *  being split across a boundary. */
const HOP_SECONDS = 2;

const MODELS = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
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
  private timer: ReturnType<typeof setInterval> | null = null;
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
    const transcriber = await pipeline("automatic-speech-recognition", MODELS[this.size], {
      progress_callback: (event: { status?: string; progress?: number }) => {
        if (event.status === "progress" && typeof event.progress === "number") {
          handlers.onStatus({
            kind: "loading",
            detail: `Loading the ${this.size} speech model`,
            progress: event.progress / 100,
          });
        }
      },
    });
    this.transcriber = transcriber as unknown as typeof this.transcriber;

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
    this.timer = setInterval(() => void this.pass(handlers), HOP_SECONDS * 1000);
    handlers.onStatus({ kind: "listening" });
  }

  /** Transcribe the current window, skipping if a previous pass is still running. */
  private async pass(handlers: EngineHandlers): Promise<void> {
    if (!this.running || this.busy || !this.transcriber) return;
    // Below roughly a second there is nothing worth sending.
    if (this.filled < SAMPLE_RATE) return;

    this.busy = true;
    try {
      const audio = this.buffer.slice(this.buffer.length - this.filled);
      const output = await this.transcriber(audio, {
        language: this.language,
        task: "transcribe",
        return_timestamps: false,
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
      this.busy = false;
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      clearInterval(this.timer);
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
