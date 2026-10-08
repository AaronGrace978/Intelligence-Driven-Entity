import { signal } from "./signal";
import type { PadAxis, PadButton, PadEvent } from "./types";

/**
 * Turns controller input into UI actions: D-pad and left stick move focus between controls,
 * A presses, B backs out, triggers scroll, the right stick steers the entity's gaze.
 */

export type Direction = "up" | "down" | "left" | "right";
export type PadAction = Direction | "a" | "b" | "x" | "y" | "lb" | "rb" | "start" | "select";

const BUTTON_ACTION: Partial<Record<PadButton, PadAction>> = {
  south: "a",
  east: "b",
  west: "x",
  north: "y",
  lb: "lb",
  rb: "rb",
  start: "start",
  select: "select",
  up: "up",
  down: "down",
  left: "left",
  right: "right",
};

const DIRECTIONS: Direction[] = ["up", "down", "left", "right"];
const isDirection = (a: PadAction): a is Direction => (DIRECTIONS as string[]).includes(a);

const REPEAT_DELAY = 380;
const REPEAT_EVERY = 110;
const STICK_ON = 0.6;
const STICK_OFF = 0.4;
const GAZE_DEADZONE = 0.12;
const SCROLL_SPEED = 1100;

const FOCUSABLE = 'button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

/** A component that handles actions itself while it is open (the on-screen keyboard). */
type Claim = (action: PadAction) => boolean;
let claim: Claim | null = null;

/** Remember where focus was so the next D-pad press continues from there after a blur. */
export function rememberFocus(el: Element | null) {
  if (el) lastFocus = el;
}

export function claimPad(handler: Claim): () => void {
  claim = handler;
  return () => {
    if (claim === handler) claim = null;
  };
}

const activeListeners = new Set<(active: boolean) => void>();
let padActive = false;

export function onPadActive(listener: (active: boolean) => void): () => void {
  activeListeners.add(listener);
  listener(padActive);
  return () => activeListeners.delete(listener);
}

function setPadActive(next: boolean) {
  if (padActive === next) return;
  padActive = next;
  document.documentElement.classList.toggle("pad-nav", next);
  activeListeners.forEach((l) => l(next));
}

const axes: Record<PadAxis, number> = { leftX: 0, leftY: 0, rightX: 0, rightY: 0, leftTrigger: 0, rightTrigger: 0 };
/** Held directions and when each next repeats; the D-pad and the stick share these. */
const held = new Map<Direction, number>();
let stickDir: Direction | null = null;
let gazing = false;
let lastFocus: Element | null = null;
let ticker = 0;
let lastTick = 0;

function visible(el: Element) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
}

function scope(): ParentNode {
  return document.querySelector(".drawer") ?? document.querySelector(".model-menu") ?? document.body;
}

function focusables(root: ParentNode): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => !el.closest(".deck-keys") && visible(el));
}

function onScreen(el: Element) {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < window.innerHeight && r.left < window.innerWidth;
}

function focus(el: HTMLElement) {
  el.focus({ preventScroll: true });
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  lastFocus = el;
}

/** Gap along the travel direction plus a heavier penalty for drifting sideways. */
export function score(from: DOMRect, to: DOMRect, dir: Direction): number | null {
  const vertical = dir === "up" || dir === "down";
  const gap =
    dir === "down" ? to.top - from.bottom : dir === "up" ? from.top - to.bottom : dir === "right" ? to.left - from.right : from.left - to.right;
  const fromCentre = vertical ? (from.top + from.bottom) / 2 : (from.left + from.right) / 2;
  const toCentre = vertical ? (to.top + to.bottom) / 2 : (to.left + to.right) / 2;
  const ahead = dir === "down" || dir === "right" ? toCentre > fromCentre + 1 : toCentre < fromCentre - 1;
  if (!ahead || gap < -Math.min(vertical ? from.height : from.width, 12)) return null;
  const [a0, a1, b0, b1] = vertical ? [from.left, from.right, to.left, to.right] : [from.top, from.bottom, to.top, to.bottom];
  const drift = Math.max(0, b0 - a1, a0 - b1);
  return Math.max(0, gap) + drift * 3;
}

function current(root: ParentNode): HTMLElement | null {
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body && root.contains(active) && !active.closest(".deck-keys")) return active;
  if (lastFocus instanceof HTMLElement && lastFocus.isConnected && root.contains(lastFocus)) return lastFocus;
  return null;
}

function move(dir: Direction) {
  const root = scope();
  const all = focusables(root);
  const from = current(root);
  if (!from) {
    const first = all.find(onScreen) ?? all[0];
    if (first) focus(first);
    return;
  }
  const rect = from.getBoundingClientRect();
  let best: HTMLElement | null = null;
  let bestScore = Infinity;
  for (const pass of [all.filter(onScreen), all]) {
    for (const el of pass) {
      if (el === from) continue;
      const s = score(rect, el.getBoundingClientRect(), dir);
      if (s !== null && s < bestScore) {
        best = el;
        bestScore = s;
      }
    }
    if (best) break;
  }
  if (best) focus(best);
}

function stepSelect(el: HTMLSelectElement, delta: number) {
  const n = el.options.length;
  if (!n) return;
  const next = el.options[(el.selectedIndex + delta + n) % n];
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(el, next.value);
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function click(selector: string): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el || (el instanceof HTMLButtonElement && el.disabled)) return false;
  el.click();
  return true;
}

function cycleRenderer(delta: number) {
  const tabs = Array.from(document.querySelectorAll<HTMLButtonElement>(".renderer-switch button"));
  if (!tabs.length) return;
  const at = Math.max(0, tabs.findIndex((t) => t.getAttribute("aria-selected") === "true"));
  tabs[(at + delta + tabs.length) % tabs.length].click();
}

function afterRender(fn: () => void) {
  setTimeout(fn, 40);
}

function focusComposer() {
  const area = document.querySelector<HTMLTextAreaElement>(".composer textarea");
  if (area) focus(area);
}

function toggleModelMenu() {
  if (!click(".model-button")) return;
  afterRender(() => {
    const pick = document.querySelector<HTMLElement>(".model-list button.on") ?? document.querySelector<HTMLElement>(".model-list button");
    if (pick) focus(pick);
    else (document.querySelector<HTMLElement>(".model-button") ?? undefined)?.focus();
  });
}

function back() {
  if (document.querySelector(".model-menu")) {
    click(".model-button");
    afterRender(() => document.querySelector<HTMLElement>(".model-button")?.focus());
    return;
  }
  if (document.querySelector(".drawer")) {
    click(".drawer-head .ghost");
    afterRender(() => {
      const config = document.querySelector<HTMLElement>(".config-button");
      if (config) focus(config);
    });
    return;
  }
  if (click(".send.stop")) return;
  const active = document.activeElement;
  if (active instanceof HTMLElement && active !== document.body) {
    lastFocus = active;
    active.blur();
  }
}

function activate() {
  const el = current(scope());
  if (!el) {
    move("down");
    return;
  }
  if (el instanceof HTMLSelectElement) stepSelect(el, 1);
  else if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && el.type !== "checkbox")) focus(el);
  else el.click();
}

export function perform(action: PadAction) {
  if (claim?.(action)) return;
  if (isDirection(action)) {
    move(action);
    return;
  }
  switch (action) {
    case "a":
      activate();
      break;
    case "b":
      back();
      break;
    case "x":
      focusComposer();
      break;
    case "y":
    case "rb":
      cycleRenderer(1);
      break;
    case "lb":
      cycleRenderer(-1);
      break;
    case "start":
      if (document.querySelector(".drawer")) back();
      else if (click(".config-button")) afterRender(() => move("down"));
      break;
    case "select":
      if (document.querySelector(".model-menu")) back();
      else toggleModelMenu();
      break;
  }
}

function press(dir: Direction) {
  if (held.has(dir)) return;
  held.set(dir, performance.now() + REPEAT_DELAY);
  perform(dir);
  ensureTicker();
}

function release(dir: Direction) {
  held.delete(dir);
}

function stickDirection(): Direction | null {
  const x = axes.leftX;
  const y = axes.leftY;
  const mag = Math.max(Math.abs(x), Math.abs(y));
  const threshold = stickDir ? STICK_OFF : STICK_ON;
  if (mag < threshold) return null;
  if (Math.abs(x) > Math.abs(y)) return x > 0 ? "right" : "left";
  return y > 0 ? "up" : "down";
}

function scrollTarget(): HTMLElement | null {
  if (document.querySelector(".drawer")) return document.querySelector(".drawer");
  if (document.querySelector(".model-menu")) return document.querySelector(".model-list");
  return document.querySelector(".chat-scroll");
}

function tick() {
  const now = performance.now();
  const dt = Math.min(0.05, (now - lastTick) / 1000);
  lastTick = now;

  const dir = stickDirection();
  if (dir !== stickDir) {
    if (stickDir) release(stickDir);
    stickDir = dir;
    if (dir) {
      setPadActive(true);
      press(dir);
    }
  }

  for (const [d, at] of held) {
    if (now >= at) {
      held.set(d, now + REPEAT_EVERY);
      perform(d);
    }
  }

  const scroll = axes.rightTrigger - axes.leftTrigger;
  if (Math.abs(scroll) > 0.05) scrollTarget()?.scrollBy({ top: scroll * SCROLL_SPEED * dt });

  const gx = axes.rightX;
  const gy = axes.rightY;
  if (Math.abs(gx) > GAZE_DEADZONE || Math.abs(gy) > GAZE_DEADZONE) {
    signal.look.x = gx;
    signal.look.y = gy;
    gazing = true;
  } else if (gazing) {
    signal.look.x = 0;
    signal.look.y = 0;
    gazing = false;
  }

  const idle = !held.size && !stickDir && !gazing && Math.abs(scroll) <= 0.05;
  if (idle) {
    clearInterval(ticker);
    ticker = 0;
  }
}

function ensureTicker() {
  if (ticker) return;
  lastTick = performance.now();
  ticker = window.setInterval(tick, 16);
}

export function feedPad(e: PadEvent) {
  switch (e.kind) {
    case "button": {
      const action = BUTTON_ACTION[e.button];
      if (!action) return;
      if (e.pressed) setPadActive(true);
      if (isDirection(action)) {
        if (e.pressed) press(action);
        else release(action);
      } else if (e.pressed) {
        perform(action);
      }
      break;
    }
    case "axis":
      axes[e.axis] = e.value;
      ensureTicker();
      break;
    case "disconnected":
      held.clear();
      for (const k of Object.keys(axes) as PadAxis[]) axes[k] = 0;
      ensureTicker();
      break;
    case "connected":
      break;
  }
}

/** Any mouse, touch or physical key hands the UI back to pointer mode and hides the focus ring. */
export function watchPointer(): () => void {
  const off = () => setPadActive(false);
  const onMove = (e: MouseEvent) => {
    if (e.movementX || e.movementY) off();
  };
  window.addEventListener("pointerdown", off, true);
  window.addEventListener("mousemove", onMove, true);
  window.addEventListener("keydown", off, true);
  return () => {
    window.removeEventListener("pointerdown", off, true);
    window.removeEventListener("mousemove", onMove, true);
    window.removeEventListener("keydown", off, true);
  };
}
