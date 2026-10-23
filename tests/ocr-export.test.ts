import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts, degrees, rgb } from "pdf-lib";
import { addOcrTextLayer } from "../electron/ocr-export";
import type { OcrPage } from "../electron/pdf-types";

async function reader(bytes: Uint8Array) {
  const canvas = await import("@napi-rs/canvas");
  for (const key of ["DOMMatrix", "ImageData", "Path2D"] as const)
    (globalThis as any)[key] = canvas[key];
  const { getDocument, Util, OPS } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false, disableFontFace: true });
  return { task, doc: await task.promise, canvas, Util, OPS };
}
function ocr(text = "한글 OCR export") : OcrPage {
  return { text, lines: [{ text, x: 0.1, y: 0.2, w: 0.7, h: 0.1 }] };
}
async function pixels(r: Awaited<ReturnType<typeof reader>>, index: number) {
  const page = await r.doc.getPage(index), viewport = page.getViewport({ scale: 1 });
  const canvas = r.canvas.createCanvas(viewport.width, viewport.height);
  await page.render({ canvasContext: canvas.getContext("2d") as any, viewport }).promise;
  return canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
}

test("OCR adds searchable Korean and Latin without changing visible pixels on cropped rotated pages", async () => {
  const pdf = await PDFDocument.create();
  for (const rotation of [0, 90, 180, 270]) {
    const page = pdf.addPage([400, 600]);
    page.setCropBox(30, 40, 200, 300);
    page.setRotation(degrees(rotation));
    page.drawRectangle({ x: 50, y: 80, width: 120, height: 160, color: rgb(0.2, 0.4, 0.8) });
  }
  const original = await pdf.save();
  const pages = new Map([0, 1, 2, 3].map(i => [i, ocr()]));
  const exported = await PDFDocument.load(original);
  await addOcrTextLayer(exported, pages, undefined);
  const before = await reader(original), after = await reader(await exported.save());
  try {
    for (let i = 0; i < 4; i++) {
      assert.deepEqual(await pixels(after, i + 1), await pixels(before, i + 1));
      const page = await after.doc.getPage(i + 1), viewport = page.getViewport({ scale: 1 });
      const operators = await page.getOperatorList();
      assert.ok(operators.fnArray.some((fn, j) => fn === after.OPS.setTextRenderingMode && operators.argsArray[j][0] === 3), "OCR uses PDF rendering mode Invisible (3)");
      const content = await page.getTextContent();
      const items = content.items.filter((v: any) => "str" in v) as any[];
      assert.equal(items.map(v => v.str).join(""), "한글 OCR export", `rotation ${i * 90}`);
      const first = items.find(v => v.str.trim());
      const display = after.Util.transform(viewport.transform, first.transform);
      assert.ok(Math.abs(display[4] - viewport.width * 0.1) < 0.01, `rotation ${i * 90}: x ${display[4]}`);
      assert.ok(display[5] >= viewport.height * 0.2 && display[5] <= viewport.height * 0.3);
      assert.ok(Math.abs(display[1]) < 0.01, "displayed baseline is horizontal");
      const last = items.filter(v => v.str.trim()).at(-1)!;
      const end = after.Util.transform(viewport.transform, last.transform)[4] + last.width;
      assert.ok(Math.abs(end - viewport.width * 0.8) < 0.1, `fitted line ends at ${end}`);
    }
  } finally { await before.task.destroy(); await after.task.destroy(); }
});

test("partial OCR keeps native text and unrecognized pages; separate lines retain line breaks", async () => {
  const pdf = await PDFDocument.create(), native = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([300, 300]).drawText("Original native text", {font: native, x: 20, y: 280, size: 10});
  pdf.addPage([300, 300]);
  const data = ocr("첫째 line");
  data.lines.push({text: "둘째 line", x: 0.1, y: 0.5, w: 0.7, h: 0.1});
  await addOcrTextLayer(pdf, new Map([[0, data]]), undefined);
  const result = await reader(await pdf.save());
  try {
    const content = await (await result.doc.getPage(1)).getTextContent();
    const items = content.items.filter((v:any) => "str" in v) as any[];
    const text = items.map(v => v.str + (v.hasEOL ? "\n" : "")).join("");
    assert.ok(text.includes("Original native text"));
    assert.match(text, /첫째 line\n둘째 line/);
    assert.equal((await (await result.doc.getPage(2)).getTextContent()).items.length, 0);
  } finally { await result.task.destroy(); }
});

test("empty OCR and zero-area lines do not embed a font", async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const before = pdf.context.enumerateIndirectObjects().length;
  await addOcrTextLayer(pdf, new Map());
  await addOcrTextLayer(pdf, new Map([[0, {text:"",lines:[{text:"",x:0,y:0,w:1,h:1},{text:"zero",x:0,y:0,w:0,h:0.1}]}]]));
  assert.equal(pdf.context.enumerateIndirectObjects().length, before);
});

test("invalid OCR geometry and page indices are rejected", async () => {
  for (const line of [{...ocr().lines[0],x:NaN},{...ocr().lines[0],w:-1},{...ocr().lines[0],x:0.8,w:0.5}]) {
    const pdf = await PDFDocument.create(); pdf.addPage();
    await assert.rejects(addOcrTextLayer(pdf, new Map([[0,{text:line.text,lines:[line]}]]), undefined), /geometry/i);
  }
  const pdf = await PDFDocument.create(); pdf.addPage();
  await assert.rejects(addOcrTextLayer(pdf,new Map([[1,ocr()]]),undefined),/page/i);
});

test("OCR text is wrapped in a /RustyOCR marked-content section and the font is subset", async () => {
  const pdf = await PDFDocument.create(); pdf.addPage([300, 300]);
  await addOcrTextLayer(pdf, new Map([[0, ocr()]]));
  const bytes = await pdf.save();
  assert.ok(bytes.length < 400_000, `size ${bytes.length}`);
  const reloaded = await PDFDocument.load(bytes);
  const contents = reloaded.getPage(0).node.Contents() as any;
  const streams = contents.asArray ? contents.asArray().map((r: any) => reloaded.context.lookup(r)) : [contents];
  const { decodePDFRawStream } = await import("pdf-lib");
  const text = streams.map((s: any) => Buffer.from(decodePDFRawStream(s).decode()).toString("latin1")).join("\n");
  assert.match(text, /\/RustyOCR BMC[\s\S]*EMC/);
});
