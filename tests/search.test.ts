import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPageText,
  searchPageText,
  nextSearchIndex,
  mergeSearchHits,
  itemRect,
} from "../src/search/model";
import { collapseSpaces } from "../src/ocr/copyText";

const rect = (x: number, w = 0.1) => ({ x, y: 0, w, h: 0.1 });

test("대한민국 split across 4 items matches with 4 rects", () => {
  const page = buildPageText(
    ["대", "한", "민", "국"].map((str, i) => ({ str, rect: rect(i * 0.1) })),
  );
  const hits = searchPageText(0, page, "대한민국");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].rectangles?.length, 4);
  assert.equal(hits[0].start, 0);
  assert.equal(hits[0].length, 4);
});

test("matching ignores whitespace differences both ways", () => {
  const page = buildPageText([
    { str: "hello  ", rect: rect(0, 0.7) },
    { str: " world", rect: rect(0.7, 0.3) },
  ]);
  assert.equal(searchPageText(0, page, "hello world").length, 1);
  assert.equal(searchPageText(0, page, "helloworld").length, 1);
  assert.equal(searchPageText(0, page, "hel lo").length, 1);
  assert.equal(searchPageText(0, page, "   ").length, 0);
});

test("hasEOL joins with a newline, like PDF.js", () => {
  const page = buildPageText([
    { str: "ab", hasEOL: true, rect: rect(0) },
    { str: "cd", rect: rect(0.1) },
  ]);
  assert.equal(page.text, "ab\ncd");
  assert.equal(searchPageText(0, page, "b\nc").length, 1);
  assert.equal(searchPageText(0, page, "bc")[0].rectangles?.length, 2);
});

test("incremental merge replaces only new pages and keeps the active match", () => {
  const h = (page: number, start: number) => ({
    page,
    start,
    length: 1,
    snippet: "",
  });
  const prev = [h(0, 3), h(2, 1), h(2, 9)];
  const merged = mergeSearchHits(prev, [h(1, 5)], [1], 2);
  assert.deepEqual(
    merged.hits.map((x) => [x.page, x.start]),
    [[0, 3], [1, 5], [2, 1], [2, 9]],
  );
  assert.equal(merged.activeIndex, 3);
  const dropped = mergeSearchHits(prev, [], [2], 1);
  assert.equal(dropped.activeIndex, -1);
});

test("nextSearchIndex wraps and itemRect normalizes rotated viewports", () => {
  assert.equal(nextSearchIndex(-1, 1, 3), 0);
  assert.equal(nextSearchIndex(0, -1, 3), 2);
  const r = itemRect(
    { transform: [10, 0, 0, 10, 50, 100], width: 20, height: 10 },
    { transform: [1, 0, 0, -1, 0, 200], width: 100, height: 200 },
  );
  assert.deepEqual(r, { x: 0.5, y: 0.45, w: 0.2, h: 0.05 });
});

test("collapseSpaces folds runs but keeps line breaks", () => {
  assert.equal(collapseSpaces("a  \t b\n c   d"), "a b\n c d");
});

test("worker OCR invokes pass expectedRevision, not revision", async () => {
  const { readFileSync } = await import("node:fs");
  for (const [file, cmd] of [
    ["src/ocr/TextLayer.tsx", "pdf_ocr_lines"],
    ["src/search/SearchPanel.tsx", "pdf_ocr_all_lines"],
  ]) {
    const src = readFileSync(file, "utf8");
    const at = src.indexOf(`"${cmd}"`);
    const args = src.slice(at, src.indexOf("}", at));
    assert.match(args, /expectedRevision/);
    assert.doesNotMatch(args, /^\s*revision,?\s*$/m);
  }
});
