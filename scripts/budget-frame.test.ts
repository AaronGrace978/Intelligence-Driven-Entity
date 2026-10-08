import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveBudget } from "../src/lib/budget.ts";
import { drawingBufferSize } from "../src/lib/frame-size.ts";

test("a deck stage is clamped on its long edge", () => {
  const sized = drawingBufferSize(640, 720, 360);
  assert.deepEqual(sized, { width: 320, height: 360 });
});

test("a buffer that already fits is left alone", () => {
  assert.deepEqual(drawingBufferSize(200, 100, 360), { width: 200, height: 100 });
});

test("no cap keeps the css pixel size", () => {
  assert.deepEqual(drawingBufferSize(640.2, 480.8, 0), { width: 640, height: 481 });
});

test("game mode keeps the full face and caps the buffer at the panel", () => {
  const full = resolveBudget(false, true);
  assert.equal(full.light, false);
  assert.equal(full.cellRows, 118);
  assert.equal(full.maxEdge, 1280);
  assert.equal(full.pixelRatio, 1);
  assert.equal(full.activeFps, 0);
});

test("a desktop full face stays uncapped", () => {
  const full = resolveBudget(false, false);
  assert.equal(full.maxEdge, 0);
  assert.equal(full.pixelRatio, 1.5);
  assert.equal(full.light, false);
});
