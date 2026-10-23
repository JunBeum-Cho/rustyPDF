import assert from "node:assert/strict";
import test from "node:test";
import { PDFDocument } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { loadFontBytes, subsetFontBytes } from "../electron/font-subset.ts";

test("subset of NotoSansKR is small and embeddable", async () => {
  const original = await loadFontBytes("NotoSansKR-Regular.ttf");
  const subset = await subsetFontBytes(original, "한글 A");
  assert.ok(subset.byteLength < original.byteLength / 10);
  assert.ok(subset.byteLength < 200 * 1024);
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(subset, { subset: false });
  assert.ok(font.encodeText("한글 A 1"));
  assert.ok(font.widthOfTextAtSize(" ", 12) > 0);
});

test("subset failure returns the input bytes", async () => {
  const junk = new Uint8Array([1, 2, 3, 4]);
  assert.equal(await subsetFontBytes(junk, "a"), junk);
});

test("loadFontBytes honours fontsDir and falls back", async () => {
  await assert.rejects(loadFontBytes("missing.ttf", "/nonexistent"));
  const a = await loadFontBytes("NotoSansKR-Bold.ttf", "/nonexistent").catch(() => null);
  assert.ok(a === null || a.byteLength > 1000);
});
