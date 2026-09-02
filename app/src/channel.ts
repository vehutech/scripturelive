/**
 * The link between the control view and the projected view.
 *
 * A projector is a second window the operator drags onto the second display, driven over
 * BroadcastChannel. That is deliberately the boring choice: it needs no server, no
 * pairing, and no permissions, and it works in every browser that runs the app. The
 * Presentation API would be tidier on paper and is Chrome-only in practice.
 *
 * The channel carries a heartbeat in both directions, because the one thing an operator
 * must never have to wonder about is whether the screen behind them is actually live.
 */

import type { CorpusName } from "./adapters";

export const CHANNEL_NAME = "scripture-live";

/** How often each side announces itself. */
const HEARTBEAT_MS = 1000;
/** Treat the other side as gone after this long without a heartbeat. */
const STALE_AFTER_MS = 3500;

export interface ProjectedVerse {
  ref: string;
  text: string;
  translation?: string | undefined;
  direction: "ltr" | "rtl";
  corpus: CorpusName;
}

export type ProjectionState =
  /** Nothing on screen. The default, and what a blackout returns to. */
  | { kind: "blank" }
  | { kind: "verse"; verse: ProjectedVerse };

type Message =
  | { type: "state"; state: ProjectionState }
  | { type: "hello"; role: Role }
  /** A projector asks for the current state when it opens mid-service. */
  | { type: "request" };

export type Role = "control" | "projector";

/**
 * Whether a match may reach the room without the operator touching anything.
 *
 * This is the safety rule of the projected view, so it lives on its own and is tested on
 * its own rather than being buried in event handlers. A wrong verse behind a speaker is
 * the failure this product cannot afford, so the default is to hold:
 *
 *   - below the confidence bar, hold — the control view still shows it
 *   - an ambiguous reference holds even if scored highly, because the words being right
 *     is not the same as the reference being right
 *   - with auto-send off, everything holds
 *
 * A match with no confidence at all came from the operator, by search or by history, and
 * is theirs to make rather than a guess to second-guess.
 */
export function shouldAutoProject(input: {
  confidence?: number | undefined;
  ambiguousReference?: boolean | undefined;
  autoSend: boolean;
  threshold: number;
}): boolean {
  if (!input.autoSend) return false;
  if (input.ambiguousReference) return false;
  if (input.confidence === undefined) return true;
  return input.confidence >= input.threshold;
}

export class Channel {
  private channel: BroadcastChannel;
  private beat: ReturnType<typeof setInterval>;
  private lastPeerSeen = 0;
  private stateHandler: ((state: ProjectionState) => void) | null = null;
  private requestHandler: (() => void) | null = null;
  private peerHandler: ((connected: boolean) => void) | null = null;
  private peerWasConnected = false;
  private watch: ReturnType<typeof setInterval>;

  constructor(private readonly role: Role) {
    this.channel = new BroadcastChannel(CHANNEL_NAME);
    this.channel.onmessage = (event: MessageEvent<Message>) => this.receive(event.data);

    this.announce();
    this.beat = setInterval(() => this.announce(), HEARTBEAT_MS);
    this.watch = setInterval(() => this.checkPeer(), HEARTBEAT_MS);
  }

  private announce(): void {
    this.post({ type: "hello", role: this.role });
  }

  private post(message: Message): void {
    this.channel.postMessage(message);
  }

  private receive(message: Message): void {
    switch (message.type) {
      case "hello":
        // Only the opposite role counts as a peer; two control views are not a projector.
        if (message.role !== this.role) {
          this.lastPeerSeen = Date.now();
          this.checkPeer();
        }
        return;
      case "state":
        this.stateHandler?.(message.state);
        return;
      case "request":
        this.requestHandler?.();
        return;
    }
  }

  private checkPeer(): void {
    const connected = Date.now() - this.lastPeerSeen < STALE_AFTER_MS;
    if (connected !== this.peerWasConnected) {
      this.peerWasConnected = connected;
      this.peerHandler?.(connected);
    }
  }

  /** Control side: put something on the projected screen. */
  send(state: ProjectionState): void {
    this.post({ type: "state", state });
  }

  /** Projector side: ask the control view what should currently be showing. */
  requestState(): void {
    this.post({ type: "request" });
  }

  onState(handler: (state: ProjectionState) => void): void {
    this.stateHandler = handler;
  }

  onRequest(handler: () => void): void {
    this.requestHandler = handler;
  }

  /** Fires whenever the other side appears or goes away. */
  onPeer(handler: (connected: boolean) => void): void {
    this.peerHandler = handler;
  }

  get peerConnected(): boolean {
    return this.peerWasConnected;
  }

  close(): void {
    clearInterval(this.beat);
    clearInterval(this.watch);
    this.channel.close();
  }
}
