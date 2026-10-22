import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, degrees } from "pdf-lib";
import { flattenPdf } from "../electron/export";
test("rotated Korean measured text export reloads", async () => {
  const p = await PDFDocument.create();
  const page = p.addPage([200, 300]);
  page.setRotation(degrees(90));
  const bytes = await flattenPdf(await p.save(), {
    version: 2,
    sourcePath: "x",
    updatedAt: "now",
    annotations: [
      {
        id: "k",
        page: 0,
        type: "text",
        rotation: 90,
        rect: { x: 10, y: 20, w: 80, h: 30 },
        style: { color: "#123456", width: 1 },
        payload: {
          layout: [
            {
              baseline: 15,
              fragments: [
                {
                  text: "안녕하세요 PDF",
                  x: 0,
                  fontSize: 12,
                  color: "#123456",
                  bold: true,
                  italic: true,
                  underline: true,
                },
              ],
            },
          ],
        },
      },
    ],
  });
  const result = await PDFDocument.load(bytes);
  assert.equal(result.getPageCount(), 1);
  assert.equal(result.getPage(0).getRotation().angle, 90);
  assert.ok(bytes.length > 2000);
});
test("Korean italic export renders complete glyphs on a flat baseline", async () => {
  if (!(Promise as any).withResolvers)
    (Promise as any).withResolvers = () => {
      let resolve: any, reject: any;
      const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
      });
      return { promise, resolve, reject };
    };
  if (!(ArrayBuffer.prototype as any).transferToFixedLength)
    (ArrayBuffer.prototype as any).transferToFixedLength = function () {
      return this.slice(0);
    };
  const canvasApi = await import("@napi-rs/canvas");
  for (const name of ["DOMMatrix", "ImageData", "Path2D"] as const)
    (globalThis as any)[name] = (canvasApi as any)[name];
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const p = await PDFDocument.create();
  p.addPage([595, 842]);
  const text = "한글 내보내기 RustyPDF";
  const bytes = await flattenPdf(await p.save(), {
    annotations: [
      {
        id: "k",
        page: 0,
        type: "text",
        rect: { x: 70, y: 80, w: 450, h: 90 },
        style: { color: "#112233", width: 1 },
        payload: {
          layout: [
            {
              baseline: 28,
              fragments: [
                {
                  text,
                  x: 0,
                  fontSize: 24,
                  color: "#112233",
                  bold: true,
                  italic: true,
                  underline: false,
                },
              ],
            },
          ],
        },
      },
    ],
  });
  const loadingTask = getDocument({
    data: bytes.slice(),
    useSystemFonts: false,
    disableFontFace: true,
  });
  const doc = await loadingTask.promise;
  try {
    const page = await doc.getPage(1);
    const content = await page.getTextContent();
    const items = content.items.filter((item: any) => "str" in item) as any[];
    assert.equal(items.map((item) => item.str).join(""), text);
    for (const item of items) {
      assert.equal(
        item.transform[1],
        0,
        "italic must leave baseline horizontal",
      );
      assert.equal(
        item.transform[5],
        734,
        "all fragments share measured baseline",
      );
    }
    const viewport = page.getViewport({ scale: 1 });
    const canvas = canvasApi.createCanvas(viewport.width, viewport.height);
    const context = canvas.getContext("2d");
    await page.render({ canvasContext: context as any, viewport }).promise;
    // Every Hangul glyph must contain substantial ink; malformed CFF subsets
    // previously retained just disconnected fragments for the middle syllables.
    const positions = [70, 94, 123.4, 147.4, 171.4, 195.4];
    for (const x of positions) {
      const pixels = context.getImageData(Math.floor(x), 84, 24, 26).data;
      let ink = 0;
      for (let i = 0; i < pixels.length; i += 4)
        if (pixels[i] < 150 && pixels[i + 1] < 150 && pixels[i + 2] < 150)
          ink++;
      assert.ok(ink > 90, `Korean glyph at ${x} has only ${ink} ink pixels`);
    }
  } finally {
    await loadingTask.destroy();
  }
});


test("export embeds distinct bundled families and weights, reuses faces, and honors fallback style", async () => {
  const p = await PDFDocument.create();
  p.addPage([595, 842]);
  const common = { page: 0, type: "text", rect: { x: 10, y: 10, w: 300, h: 40 } };
  const bytes = await flattenPdf(await p.save(), { annotations: [
    { ...common, id: "fallback", style: { color: "#000000", width: 1, fontFamily: "Georgia", fontWeight: "bold", fontSize: 24 }, payload: { text: "한글 Serif" } },
    { ...common, id: "mixed", style: { color: "#000000", width: 1 }, payload: { layout: [{ baseline: 24, fragments: [
      { text: "Sans", x: 0, fontSize: 24, fontFamily: "Arial", bold: false },
      { text: "Serif", x: 70, fontSize: 24, fontFamily: "Times New Roman", bold: false },
      { text: "Bold", x: 140, fontSize: 24, fontFamily: "Noto Serif KR", bold: true },
    ] }] } },
  ] });
  const result = await PDFDocument.load(bytes);
  const { PDFName, PDFDict } = await import("pdf-lib");
  const resources = result.getPage(0).node.Resources()!;
  const fonts = resources.lookup(PDFName.of("Font"), PDFDict);
  const refs = new Set(fonts.values().map((value) => value.toString()));
  assert.equal(refs.size, 3, "regular Sans, regular Serif, and reused bold Serif");
  const names = [...refs].map((ref) => {
    const value = fonts.values().find((value) => value.toString() === ref)!;
    const font = result.context.lookup(value, PDFDict);
    return font.get(PDFName.of("BaseFont"))!.toString();
  });
  assert.ok(names.some((name) => name.includes("NotoSerifKR")));
  assert.ok(names.some((name) => name.includes("NotoSansKR")));
});
