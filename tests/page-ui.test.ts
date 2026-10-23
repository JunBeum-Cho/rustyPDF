import assert from "node:assert/strict";
import test from "node:test";
import {
  clampMenuPosition,
  dropSlotForPointer,
  moveToIndexFromSlot,
  reindexAnnotationsForPages,
  shouldHandlePageKey,
} from "../src/viewer/pageUi";

const ctx = {
  insideThumbnailSidebar: true,
  editableTarget: false,
  hasTextSelection: false,
  mod: false,
  key: "Delete",
};

test("move: drag to last slot", () => {
  assert.equal(moveToIndexFromSlot([0], 5, 5), 4);
  assert.equal(moveToIndexFromSlot([1, 2], 5, 5), 3);
});
test("move: toIndex counts removed pages before the slot", () => {
  assert.equal(moveToIndexFromSlot([0, 1], 4, 6), 2);
  assert.equal(moveToIndexFromSlot([4], 1, 6), 1);
  assert.equal(moveToIndexFromSlot([0, 3], 2, 6), 1);
});
test("move: no-op drops", () => {
  assert.equal(moveToIndexFromSlot([2], 2, 5), null);
  assert.equal(moveToIndexFromSlot([2], 3, 5), null);
  assert.equal(moveToIndexFromSlot([1, 2], 3, 5), null);
  assert.equal(moveToIndexFromSlot([], 3, 5), null);
});
test("drop slot from pointer", () => {
  assert.equal(dropSlotForPointer(3, 110, 100, 40), 3);
  assert.equal(dropSlotForPointer(3, 130, 100, 40), 4);
});
test("menu clamps to the viewport", () => {
  assert.deepEqual(clampMenuPosition(900, 700, 200, 300, 1000, 800), { x: 792, y: 492 });
  assert.deepEqual(clampMenuPosition(-5, 3, 200, 300, 1000, 800), { x: 8, y: 8 });
  assert.deepEqual(clampMenuPosition(100, 100, 200, 300, 1000, 800), { x: 100, y: 100 });
});
test("shortcuts only inside the thumbnail sidebar", () => {
  assert.equal(shouldHandlePageKey(ctx), true);
  assert.equal(shouldHandlePageKey({ ...ctx, insideThumbnailSidebar: false }), false);
  assert.equal(shouldHandlePageKey({ ...ctx, editableTarget: true }), false);
});
test("Cmd+C with a text selection is not intercepted", () => {
  const c = { ...ctx, mod: true, key: "c" };
  assert.equal(shouldHandlePageKey(c), true);
  assert.equal(shouldHandlePageKey({ ...c, hasTextSelection: true }), false);
  assert.equal(shouldHandlePageKey({ ...c, key: "z" }), false);
});
test("reindex annotations for extracted pages", () => {
  const out = reindexAnnotationsForPages(
    [{ page: 4, id: "a" }, { page: 1, id: "b" }, { page: 2, id: "c" }],
    [1, 4],
  );
  assert.deepEqual(out, [{ page: 1, id: "a" }, { page: 0, id: "b" }]);
});

test("viewer stylesheet styles every outline class and layers overlay below annotation layer", async () => {
  const { readFileSync } = await import("node:fs");
  const viewerCss = readFileSync("src/viewer/viewer.css", "utf8");
  for (const cls of ["outline-panel", "outline-row", "outline-toggle", "outline-title", "outline-empty"])
    assert.match(viewerCss, new RegExp(`\\.${cls}\\b`));
  const z = (css: string, sel: string) =>
    Number(new RegExp(`${sel.replace(/\./g, "\\.")}\\s*\\{[^}]*?z-index:\\s*(\\d+)`).exec(css)?.[1]);
  const overlay = z(readFileSync("src/viewer/overlay.css", "utf8"), ".pdf-annotation-overlay");
  const layer = z(readFileSync("src/annotations/annotations.css", "utf8"), ".annotation-layer");
  assert.ok(overlay > 1 && overlay < layer);
});

test("form flush records a page edit history entry", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(readFileSync("src/viewer/PdfAnnotationOverlay.tsx", "utf8"), /commitPageEditHistory\(tabId, before, result\)/);
});

test("thumbnail sidebar takes its width from the sidebar pane only", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync("src/viewer/Thumbnails.tsx", "utf8");
  assert.doesNotMatch(src, /flex:\s*`0 0 \$\{sidebarWidth\(\)\}px`/);
});
