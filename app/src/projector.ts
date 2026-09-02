/**
 * The projected view.
 *
 * Deliberately dumb: it holds no state of its own, runs no recognition, and decides
 * nothing. Whatever the control window sends is what the room sees. That separation is
 * the point — a bug in matching or recognition cannot put something on the screen unless
 * the control window chose to send it.
 */

import { Channel, type ProjectionState } from "./channel";

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const ui = {
  waiting: el("waiting"),
  stage: el("stage"),
  ref: el("ref"),
  text: el("text"),
  translation: el<HTMLParagraphElement>("translation"),
};

/**
 * Long verses shrink rather than overflow. A verse cut off mid-sentence on a projection
 * screen is worse than a small one.
 */
function sizeFor(text: string): string {
  if (text.length > 240) return "text very-long";
  if (text.length > 110) return "text long";
  return "text";
}

function render(state: ProjectionState): void {
  if (state.kind === "blank") {
    ui.stage.classList.remove("visible");
    // Let the fade finish before hiding, so a blackout is not a hard cut.
    setTimeout(() => {
      ui.stage.hidden = true;
    }, 320);
    return;
  }

  const { verse } = state;
  ui.ref.textContent = verse.ref;
  ui.text.textContent = verse.text;
  ui.text.className = sizeFor(verse.text);
  ui.text.setAttribute("dir", verse.direction);

  if (verse.translation) {
    ui.translation.hidden = false;
    ui.translation.textContent = verse.translation;
  } else {
    ui.translation.hidden = true;
  }

  ui.stage.hidden = false;
  // Force layout so the transition has a starting point, then reveal synchronously.
  // requestAnimationFrame would be tidier but does not fire while the window is in the
  // background — which is exactly where a projector sits until it is dragged across.
  void ui.stage.offsetHeight;
  ui.stage.classList.add("visible");
}

const channel = new Channel("projector");

channel.onState(render);

channel.onPeer((connected) => {
  ui.waiting.classList.toggle("hidden", connected);
  ui.waiting.textContent = connected
    ? ""
    : "Control window disconnected";
  if (!connected) {
    // Leave whatever is on screen up. A dropped connection mid-service should not blank
    // the room; the operator can black out deliberately.
    ui.waiting.classList.remove("hidden");
  }
});

// Opened mid-service, this asks for whatever should already be showing.
channel.requestState();

// Keep the screen awake. Projection sessions run far past any idle timeout.
if ("wakeLock" in navigator) {
  const request = () =>
    (navigator as Navigator & { wakeLock: { request(type: "screen"): Promise<unknown> } }).wakeLock
      .request("screen")
      .catch(() => undefined);
  void request();
  // The lock is dropped whenever the tab is hidden, so it has to be retaken.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void request();
  });
}
