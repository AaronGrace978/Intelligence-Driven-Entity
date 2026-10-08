import { drawingBufferSize } from "./frame-size.ts";
import { signal } from "./signal.ts";

export { drawingBufferSize };

/**
 * How much rendering the entity may spend. Renderers read this once when they mount, so it must
 * be settled before the first render (see `main.tsx`).
 */
export interface RenderBudget {
  /** Upper bound on devicePixelRatio for WebGL canvases. */
  pixelRatio: number;
  /** Frame cap while the model is streaming or the face is reacting; 0 means the display rate. */
  activeFps: number;
  /** Frame cap while nothing is happening. */
  idleFps: number;
  /** Voxel rows in the MATRIX cell pass. */
  cellRows: number;
  /** Longitude × latitude segments of the ASCII head mesh. */
  asciiSegments: [number, number];
  /** Per-frame text-shadow on the ASCII glyphs and the SVG blur on the wireframe. */
  glow: boolean;
  /**
   * Deck-only cheaper MATRIX shader. Stays false on a desktop, and on a Deck until
   * `setLightGraphics(true)`.
   */
  light: boolean;
  /**
   * Longest edge of the WebGL drawing buffer, in pixels. `0` keeps the CSS size times
   * `pixelRatio`. The Deck's lite mode caps this and lets the canvas scale up, because the
   * matrix face is a voxel grid and a full 1280×800 shader is what drops the OLED panel to ~10 fps.
   */
  maxEdge: number;
  /** Cap on ASCII columns. `0` sizes the glyph grid to the stage. */
  asciiMaxColumns: number;
  /** This session is a Steam Deck. Set before the first React render. */
  deck: boolean;
}

const DESKTOP: RenderBudget = {
  pixelRatio: 1.5,
  activeFps: 0,
  idleFps: 0,
  cellRows: 118,
  asciiSegments: [84, 64],
  glow: true,
  light: false,
  maxEdge: 0,
  asciiMaxColumns: 0,
  deck: false,
};

/**
 * The OLED panel is 90 Hz and the LCD is 60 Hz. 30 fps lands on every third OLED refresh and
 * every other LCD refresh, so the face doesn't judder the way a 60 fps cap does on 90 Hz.
 * Lite mode also caps the drawing buffer (see `setLightGraphics`).
 */

/** Long edge of the Deck panel. Game Mode must not raymarch a larger gamescope resolution. */
const PANEL_LONG_EDGE = 1280;

let sessionGameMode = false;

const DECK: RenderBudget = {
  pixelRatio: 1,
  activeFps: 30,
  idleFps: 30,
  cellRows: 64,
  asciiSegments: [40, 28],
  glow: false,
  light: false,
  maxEdge: 0,
  asciiMaxColumns: 72,
  deck: true,
};

const GRAPHICS_KEY = "entity.graphics.v5";

export const budget: RenderBudget = { ...DESKTOP };

/**
 * 1.0 was the full face, and that is what ran smoothly on the Deck. Lite is opt-in.
 * The key is versioned so an older build that saved "deck" automatically does not keep the cap.
 */
export function lightGraphicsPreferred(): boolean {
  try {
    return localStorage.getItem(GRAPHICS_KEY) === "deck";
  } catch {
    return false;
  }
}

/**
 * Recorded before the first render. Game Mode uses it to keep the full face from
 * raymarching a gamescope resolution larger than the panel.
 */
export function notePlatform(gameMode: boolean) {
  sessionGameMode = gameMode;
}

/**
 * The full face is the desktop budget. Game Mode keeps that face and only refuses
 * a drawing buffer bigger than the panel. Lite is the small buffer, Deck-only.
 */
export function resolveBudget(light: boolean, gameMode: boolean): RenderBudget {
  if (light) {
    return {
      ...DECK,
      light: true,
      cellRows: 48,
      maxEdge: 360,
      asciiSegments: [32, 22],
      asciiMaxColumns: 48,
    };
  }
  if (gameMode) {
    return { ...DESKTOP, deck: true, pixelRatio: 1, maxEdge: PANEL_LONG_EDGE };
  }
  return { ...DESKTOP };
}

/**
 * Turns the cheaper face shader on or off. Only meaningful on a Deck: it starts from the Deck
 * budget, then (when on) drops the voxel grid and the internal resolution as well. Desktop
 * rendering never calls this.
 */
export function setLightGraphics(on: boolean) {
  Object.assign(budget, resolveBudget(on, sessionGameMode));
  try {
    localStorage.setItem(GRAPHICS_KEY, on ? "deck" : "full");
  } catch {
    /* A private window still gets the choice for this session. */
  }
}

function busy() {
  const o = signal.out;
  return signal.streaming || o.activity > 0.03 || o.error > 0.02 || o.success > 0.05 || o.speak > 0.02;
}

/**
 * Returns a gate for a requestAnimationFrame loop: the seconds since the last drawn frame, or
 * `null` when this frame should be skipped to stay under the current cap.
 */
export function createPacer(maxDt = 0.1) {
  let last = performance.now();
  let lastDrawn = last;
  /** Milliseconds owed toward the next frame. Carrying the remainder keeps 30 fps on a 60 Hz LCD and a 90 Hz OLED. */
  let owed = 0;
  return (now: number): number | null => {
    const fps = busy() ? budget.activeFps : budget.idleFps;
    const step = now - last;
    last = now;
    if (fps > 0) {
      const interval = 1000 / fps;
      owed += step;
      // 1 ms of tolerance absorbs vsync timestamp jitter.
      if (owed < interval - 1) return null;
      owed = Math.min(owed - interval, interval);
    } else {
      owed = 0;
    }
    const dt = (now - lastDrawn) / 1000;
    lastDrawn = now;
    return Math.min(maxDt, dt);
  };
}
