/**
 * The recognition boundary.
 *
 * Everything above this interface is corpus and matching logic that does not care where
 * text came from. Everything below is a specific engine. Phase 0 measured that better
 * recognition buys about four points of verse accuracy while tracking buys nine, so the
 * point of this seam is not accuracy — it is that the Web Speech API exists in only two
 * of the four browser engines, and owning recognition is what makes the product work
 * everywhere.
 */

export interface Utterance {
  /** Recognized text. Already trimmed, never normalized — the caller owns that. */
  text: string;
  /** False while the engine may still revise this text. */
  isFinal: boolean;
}

export type EngineStatus =
  | { kind: "idle" }
  | { kind: "loading"; detail: string; progress?: number }
  | { kind: "listening" }
  | { kind: "stopped" }
  /** Recoverable: the engine keeps running or will retry. */
  | { kind: "warning"; message: string }
  /** Terminal for this session: the engine has stopped and will not restart itself. */
  | { kind: "error"; message: string };

export interface EngineHandlers {
  onUtterance: (utterance: Utterance) => void;
  onStatus: (status: EngineStatus) => void;
}

export interface Engine {
  /** Stable identifier, shown to the user when explaining what is running. */
  readonly id: string;
  readonly label: string;
  /** Whether this engine can run in the current browser at all. */
  isSupported(): boolean;
  /** Begin listening. Resolves once audio is actually being captured. */
  start(handlers: EngineHandlers): Promise<void>;
  stop(): void;
}

/**
 * Keep only the last `maxWords` words.
 *
 * The prototype rebuilt its query from every result the session had ever produced, so
 * after roughly sixty spoken content words the true verse could no longer clear the
 * match threshold — the denominator had grown past it. Matching wants a window of recent
 * speech, not a transcript.
 */
export function tailWords(text: string, maxWords = 15): string {
  const words = text.split(/\s+/).filter(Boolean);
  return words.length <= maxWords ? words.join(" ") : words.slice(-maxWords).join(" ");
}
