import test from "node:test";
import assert from "node:assert/strict";
import {
  searchLines,
  nextSearchIndex,
  highlightGeometry,
} from "../src/search/model";
test("multiple Unicode matches and cross-line rectangles retain source spaces", () => {
  const hits = searchLines(
    0,
    [{ text: "😀 한국 한국", x: 0, y: 0, w: 0.8, h: 0.1 }],
    [{ text: "scan", x: 0.2, y: 0.4, w: 0.4, h: 0.1 }],
    "한국",
  );
  assert.equal(hits.length, 2);
  assert.equal(hits[0].start, 2);
  assert.equal(hits[0].space, "raw");
  assert.deepEqual(hits[0].rectangles, [
    { x: (0.8 * 2) / 7, y: 0, w: (0.8 * 2) / 7, h: 0.1 },
  ]);
  const cross = searchLines(
    0,
    [],
    [
      { text: "hello", x: 0, y: 0, w: 1, h: 0.1 },
      { text: "world", x: 0, y: 0.2, w: 1, h: 0.1 },
    ],
    "lo\nwo",
  );
  assert.equal(cross[0].rectangles?.length, 2);
  assert.equal(cross[0].space, "display");
});
test("first navigation selects first result, subsequent navigation wraps", () => {
  assert.equal(nextSearchIndex(-1, 1, 3), 0);
  assert.equal(nextSearchIndex(0, -1, 3), 2);
  assert.equal(nextSearchIndex(2, 1, 3), 0);
});
test("native bounds apply intrinsic rotation once and OCR only viewer rotation", () => {
  const page = { width: 200, height: 100, rotation: 90 };
  assert.deepEqual(highlightGeometry(page, 2, 0, "raw"), {
    width: 200,
    height: 400,
    transform: "translateX(400px) rotate(90deg)",
  });
  assert.deepEqual(highlightGeometry(page, 2, 0, "display"), {
    width: 400,
    height: 200,
    transform: "none",
  });
});
test("repeated native lines remain searchable and Unicode case expansions retain offsets", () => {
  const line = { text: "same", x: 0, y: 0, w: 1, h: 0.1 };
  assert.equal(
    searchLines(0, [line, { ...line, y: 0.2 }], [line], "same").length,
    2,
  );
  const hits = searchLines(0, [{ ...line, text: "İ 😀 target" }], [], "target");
  assert.equal(hits[0].start, 4);
  assert.equal(hits[0].length, 6);
});
