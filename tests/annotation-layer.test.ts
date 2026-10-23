import assert from "node:assert/strict";
import test from "node:test";
import {
  moveQuads,
  normalizeCaptureRect,
  simplifyPoints,
  unionRect,
} from "../src/annotations/layerGeometry";
import { needsOrientationBake } from "../src/images/normalize";

test("capture of a 200x100pt drag is normalized by page size", () => {
  const n = normalizeCaptureRect(
    { x: 100, y: 200, w: 200, h: 100 },
    { width: 600, height: 800 },
  )!;
  assert.deepEqual(
    [n.x, n.y, n.w, n.h].map((v) => Number(v.toFixed(4))),
    [0.1667, 0.25, 0.3333, 0.125],
  );
});

test("capture rect is clamped to the page and rejects empties", () => {
  const n = normalizeCaptureRect({ x: 500, y: 700, w: 400, h: 400 }, { width: 600, height: 800 })!;
  assert.equal(n.x + n.w, 1);
  assert.equal(n.y + n.h, 1);
  assert.equal(normalizeCaptureRect({ x: 700, y: 0, w: 10, h: 10 }, { width: 600, height: 800 }), null);
});

test("RDP drops collinear points and keeps corners", () => {
  const pts = [
    { x: 0, y: 0 }, { x: 1, y: 0.1 }, { x: 2, y: 0 }, { x: 3, y: 0.05 }, { x: 4, y: 0 },
    { x: 4, y: 5 },
  ];
  const out = simplifyPoints(pts, 0.5);
  assert.deepEqual(out, [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 5 }]);
  assert.deepEqual(simplifyPoints(pts.slice(0, 2)), pts.slice(0, 2));
});

test("quads move by delta and union bbox covers them", () => {
  const quads = [{ x: 10, y: 10, w: 50, h: 10 }, { x: 10, y: 22, w: 30, h: 10 }];
  const moved = moveQuads(quads, { x: 5, y: -2 })!;
  assert.deepEqual(moved[1], { x: 15, y: 20, w: 30, h: 10 });
  assert.deepEqual(unionRect(moved), { x: 15, y: 8, w: 50, h: 22 });
  assert.equal(moveQuads(undefined, { x: 1, y: 1 }), undefined);
});

test("only JPEG sources are re-encoded for EXIF orientation", () => {
  assert.equal(needsOrientationBake("data:image/jpeg;base64,AAAA"), true);
  assert.equal(needsOrientationBake("data:image/jpg;base64,AAAA"), true);
  assert.equal(needsOrientationBake("data:image/png;base64,AAAA"), false);
  assert.equal(needsOrientationBake("data:image/webp;base64,AAAA"), false);
});
