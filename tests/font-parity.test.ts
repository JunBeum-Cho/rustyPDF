import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { COMMON_FONTS, normalizeFontFamily, fontFileName, ensureAnnotationFonts, ANNOTATION_FONT_FEATURES } from "../src/annotations/fonts";

test("bundled family registry deterministically replaces legacy and missing fonts", () => {
  assert.deepEqual(COMMON_FONTS, ["Noto Sans KR", "Noto Serif KR"]);
  for (const value of [undefined, "Arial", "system-ui", "Pretendard Variable", "Missing Font"])
    assert.equal(normalizeFontFamily(value), "Noto Sans KR");
  for (const value of ["Georgia", "Times New Roman", "serif", "'Noto Serif KR', serif"])
    assert.equal(normalizeFontFamily(value), "Noto Serif KR");
  assert.equal(normalizeFontFamily("Arial, serif"), "Noto Sans KR");
  assert.equal(fontFileName("Georgia", true), "NotoSerifKR-Bold.ttf");
});

test("font readiness waits for both weights and families before measurement", async () => {
  const pending: (() => void)[] = [];
  const requested: string[] = [];
  const fonts = { load: (font: string) => { requested.push(font); return new Promise<any[]>((resolve) => pending.push(() => resolve([{}]))); } };
  let ready = false;
  const wait = ensureAnnotationFonts({ fonts } as any).then(() => { ready = true; });
  await Promise.resolve();
  assert.equal(ready, false);
  assert.equal(requested.length, 4);
  pending.forEach((resolve) => resolve());
  await wait;
  assert.equal(ready, true);
});

test("sanitization normalizes inline and annotation default families without losing text", async () => {
  const dom = new JSDOM("<!doctype html>");
  Object.assign(globalThis, { window: dom.window, document: dom.window.document });
  const { sanitizeAnnotation } = await import("../src/annotations/sanitize");
  const original = { id: "a", page: 0, type: "text" as const, style: { color: "#000000", width: 1, fontFamily: "Georgia" }, payload: { html: '<font face="Arial">한글 </font><span style="font-family:Times New Roman">Serif</span>' } };
  const result = sanitizeAnnotation(original);
  assert.equal(result.style.fontFamily, "Noto Serif KR");
  const host = dom.window.document.createElement("div");
  host.innerHTML = result.payload!.html!;
  assert.equal(host.textContent, "한글 Serif");
  assert.equal(host.querySelector("font")!.getAttribute("face"), "Noto Sans KR");
  assert.equal(host.querySelector("span")!.style.fontFamily.replaceAll('"', ''), "Noto Serif KR");
  assert.equal(original.style.fontFamily, "Georgia");
});


test("Korean contextual spaces keep the same advance in shaped runs and exported whitespace", async () => {
  const { readFile } = await import("node:fs/promises");
  const { default: fontkit } = await import("@pdf-lib/fontkit");
  const text = "한글 내보내기 RustyPDF";
  for (const family of COMMON_FONTS) for (const bold of [false, true]) {
    const font = fontkit.create(await readFile(new URL(`../resources/fonts/${fontFileName(family, bold)}`, import.meta.url))) as any;
    const shaped = font.layout(text, { ...ANNOTATION_FONT_FEATURES }).glyphs.reduce((sum: number, glyph: any) => sum + glyph.advanceWidth, 0);
    const unshaped = [...text].reduce((sum, char) => sum + font.glyphForCodePoint(char.codePointAt(0)).advanceWidth, 0);
    assert.equal(shaped, unshaped, `${family} ${bold ? "bold" : "regular"} must not widen contextual spaces`);
  }
});
