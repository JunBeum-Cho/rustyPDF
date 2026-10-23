import assert from "node:assert/strict";
import { test } from "node:test";
import { selectionToQuads } from "../src/annotations/textMarkup";

const r = (left: number, top: number, width: number, height: number) => ({
  left, top, width, height, right: left + width, bottom: top + height, x: left, y: top,
});
const frames = [
  { pageIndex: 0, left: 0, top: 0, width: 200, height: 300, pageWidthPt: 100 },
  { pageIndex: 1, left: 0, top: 310, width: 200, height: 300, pageWidthPt: 100 },
];

test("selection across two pages gives two groups", () => {
  const out = selectionToQuads([r(20, 280, 100, 10), r(20, 320, 100, 10)], frames);
  assert.equal(out.length, 2);
  assert.equal(out[0].pageIndex, 0);
  assert.deepEqual(out[0].quads, [{ x: 10, y: 140, w: 50, h: 5 }]);
  assert.equal(out[1].pageIndex, 1);
  assert.deepEqual(out[1].quads, [{ x: 10, y: 5, w: 50, h: 5 }]);
});

test("rects on the same line merge", () => {
  const out = selectionToQuads([r(0, 10, 40, 10), r(40.5, 11, 40, 10), r(0, 40, 20, 10)], frames);
  assert.equal(out[0].quads.length, 2);
  assert.deepEqual(out[0].quads[0], { x: 0, y: 5, w: 40.25, h: 5.5 });
});

test("zero-size rects are dropped", () => {
  const out = selectionToQuads([r(10, 10, 0, 10), r(10, 10, 10, 0)], frames);
  assert.deepEqual(out, []);
});
