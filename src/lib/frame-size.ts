/**
 * Drawing-buffer size for a CSS box. When `maxEdge` is 0 the buffer matches the CSS pixels.
 * Otherwise the longer side is clamped and the aspect ratio is kept, so a 1280×800 stage
 * does not raymarch a 1280×800 framebuffer.
 */
export function drawingBufferSize(cssWidth: number, cssHeight: number, maxEdge: number): { width: number; height: number } {
  const w = Math.max(1, cssWidth);
  const h = Math.max(1, cssHeight);
  if (!(maxEdge > 0)) return { width: Math.round(w), height: Math.round(h) };
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}
