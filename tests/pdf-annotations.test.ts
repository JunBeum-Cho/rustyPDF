import test from "node:test";
import assert from "node:assert/strict";
import { deflateSync, inflateSync } from "node:zlib";
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFHexString, degrees } from "pdf-lib";
import { readAnnotations, stripAnnotations, writeAnnotations } from "../electron/pdf-annotations";
import { flattenPdf } from "../electron/export";
import type { Annotation, AnnotationSidecar } from "../src/annotations/types";

// 1x1 PNG
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const style = { color: "#ff0000", width: 2 };
const kinds = (): Annotation[] => [
  { id: "r1", page: 0, type: "rect", rect: { x: 10, y: 20, w: 30, h: 40 }, style: { ...style, fill: "#00ff00" } },
  { id: "e1", page: 0, type: "ellipse", rect: { x: 50, y: 20, w: 30, h: 40 }, style },
  { id: "l1", page: 0, type: "line", points: [{ x: 10, y: 100 }, { x: 80, y: 120 }], style },
  { id: "a1", page: 0, type: "arrow", points: [{ x: 10, y: 140 }, { x: 80, y: 160 }], style },
  { id: "p1", page: 0, type: "pen", points: [{ x: 10, y: 170 }, { x: 20, y: 180 }, { x: 30, y: 170 }], style },
  { id: "h1", page: 0, type: "highlight", rect: { x: 10, y: 200, w: 50, h: 12 }, style: { color: "#ffff00", width: 1, opacity: 0.4 } },
  { id: "h2", page: 0, type: "highlight", rect: { x: 10, y: 220, w: 90, h: 30 }, quads: [{ x: 10, y: 220, w: 50, h: 12 }, { x: 10, y: 238, w: 90, h: 12 }], style: { color: "#ffff00", width: 1 } },
  { id: "u1", page: 0, type: "underline", rect: { x: 10, y: 260, w: 50, h: 12 }, quads: [{ x: 10, y: 260, w: 50, h: 12 }], style },
  { id: "s1", page: 0, type: "strikeout", rect: { x: 10, y: 280, w: 50, h: 12 }, quads: [{ x: 10, y: 280, w: 50, h: 12 }], style },
  { id: "t1", page: 0, type: "text", rect: { x: 100, y: 20, w: 120, h: 40 }, style: { color: "#112233", width: 1, fontSize: 14 },
    payload: { text: "한글 text", html: "<b>한글</b> text" } },
  { id: "i1", page: 0, type: "image", rect: { x: 100, y: 100, w: 40, h: 40 }, rotation: 90, style: { color: "#000000", width: 1 }, payload: { imageSrc: makePng(2, 2, [1, 2, 3, 255, 4, 5, 6, 255, 7, 8, 9, 128, 10, 11, 12, 255]) } },
];
const sidecar = (annotations: Annotation[]): AnnotationSidecar => ({ version: 2, sourcePath: "x", updatedAt: "now", annotations });
async function blank(rotation = 0, crop = false) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 600]);
  if (crop) page.setCropBox(30, 40, 300, 400);
  page.setRotation(degrees(rotation));
  return pdf;
}

test("round trip every kind through save and load", async () => {
  for (const [rotation, crop] of [[0, false], [90, true], [180, false], [270, true]] as const) {
    const pdf = await blank(rotation, crop);
    const input = kinds();
    await writeAnnotations(pdf, sidecar(input));
    const loaded = await PDFDocument.load(await pdf.save());
    const read = readAnnotations(loaded);
    const pixels = (list: Annotation[]) => list.map((a) => decodePng(a.payload?.imageSrc)?.rgba);
    assert.deepEqual(pixels(read), pixels(input), `image pixels, rotation ${rotation}`);
    const strip = (list: Annotation[]) => list.map((a) => (a.type === "image" ? { ...a, payload: {} } : a));
    assert.deepEqual(strip(read), strip(input), `rotation ${rotation}`);
  }
});

const crcOf = (b: Buffer) => {
  let c = ~0;
  for (const x of b) { c ^= x; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; }
  return ~c >>> 0;
};
function makePng(w: number, h: number, rgba: number[]): string {
  const raw = Buffer.alloc(h * (1 + w * 4));
  for (let y = 0; y < h; y++) for (let i = 0; i < w * 4; i++) raw[y * (1 + w * 4) + 1 + i] = rgba[y * w * 4 + i];
  const chunk = (t: string, d: Buffer) => {
    const out = Buffer.alloc(12 + d.length);
    out.writeUInt32BE(d.length, 0); out.write(t, 4, "latin1"); d.copy(out, 8);
    out.writeUInt32BE(crcOf(out.subarray(4, 8 + d.length)), 8 + d.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
  return `data:image/png;base64,${png.toString("base64")}`;
}
/** Decodes 8-bit non-interlaced PNGs with filter 0 (what makePng and the codec write) to RGBA. */
function decodePng(src?: string) {
  if (!src) return undefined;
  const buf = Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
  let w = 0, h = 0, color = 0;
  const idat: Buffer[] = [];
  for (let o = 8; o < buf.length;) {
    const len = buf.readUInt32BE(o), type = buf.toString("latin1", o + 4, o + 8), data = buf.subarray(o + 8, o + 8 + len);
    assert.equal(buf.readUInt32BE(o + 8 + len), crcOf(buf.subarray(o + 4, o + 8 + len)), `crc ${type}`);
    if (type === "IHDR") { w = data.readUInt32BE(0); h = data.readUInt32BE(4); color = data[9]; assert.equal(data[8], 8); }
    if (type === "IDAT") idat.push(data);
    o += 12 + len;
  }
  const ch = { 0: 1, 2: 3, 4: 2, 6: 4 }[color as 0 | 2 | 4 | 6];
  const raw = inflateSync(Buffer.concat(idat));
  const rgba: number[] = [];
  for (let y = 0; y < h; y++) {
    assert.equal(raw[y * (1 + w * ch)], 0);
    for (let x = 0; x < w; x++) {
      const p = y * (1 + w * ch) + 1 + x * ch;
      if (ch === 1 || ch === 2) rgba.push(raw[p], raw[p], raw[p], ch === 2 ? raw[p + 1] : 255);
      else rgba.push(raw[p], raw[p + 1], raw[p + 2], ch === 4 ? raw[p + 3] : 255);
    }
  }
  return { w, h, rgba };
}
const imageNote = (id: string, imageSrc: string): Annotation =>
  ({ id, page: 0, type: "image", rect: { x: 10, y: 10, w: 40, h: 40 }, style: { color: "#000000", width: 1 }, payload: { imageSrc } });
const rustyJson = (pdf: PDFDocument, i = 0) =>
  Buffer.from(pdf.getPage(0).node.Annots()!.lookup(i, PDFDict).lookup(PDFName.of("RustyPDF"), PDFHexString).asBytes()).toString("utf8");

test("image pixels live only in the appearance and are rebuilt on read", async () => {
  const w = 64, h = 64, rgba: number[] = [];
  let seed = 7;
  for (let i = 0; i < w * h; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    rgba.push(seed & 255, (seed >> 8) & 255, (seed >> 16) & 255, i % 5 === 0 ? 40 + (i % 200) : 255);
  }
  const src = makePng(w, h, rgba);
  const pdf = await blank();
  await writeAnnotations(pdf, sidecar([imageNote("alpha", src)]));
  assert.ok(!rustyJson(pdf).includes("imageSrc"), "JSON carries no pixels");
  const bytes = await pdf.save();
  assert.ok(bytes.length < src.length * 1.6, `saved ${bytes.length} vs data URL ${src.length}`);
  const [read] = readAnnotations(await PDFDocument.load(bytes));
  assert.deepEqual(decodePng(read.payload?.imageSrc), { w, h, rgba });
  assert.equal(read.payload?.imageFromAppearance, undefined);
});

test("opaque and JPEG images rebuild from the appearance", async () => {
  const opaque = [10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255];
  // Minimal JPEG: SOI, SOF0 (8-bit, 2x2, 3 components), EOI. pdf-lib only parses the frame header.
  // A comment segment keeps it above Node's 4 KB Buffer pool, which pdf-lib's DataView(buffer) cannot read.
  const comment = Buffer.concat([Buffer.from([0xff, 0xfe, 0x13, 0x8a]), Buffer.alloc(5000, 0x41)]);
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8]), comment, Buffer.from([0xff, 0xc0, 0, 17, 8, 0, 2, 0, 2, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9])]);
  const jpegSrc = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  const pdf = await blank();
  await writeAnnotations(pdf, sidecar([imageNote("o", makePng(2, 2, opaque)), imageNote("j", jpegSrc)]));
  const read = readAnnotations(await PDFDocument.load(await pdf.save()));
  assert.deepEqual(decodePng(read[0].payload?.imageSrc)?.rgba, opaque);
  assert.equal(read[1].payload?.imageSrc, jpegSrc);
});

test("files whose JSON still embeds imageSrc keep loading", async () => {
  const pdf = await blank();
  await writeAnnotations(pdf, sidecar([imageNote("old", PNG)]));
  const dict = pdf.getPage(0).node.Annots()!.lookup(0, PDFDict);
  dict.set(PDFName.of("RustyPDF"), PDFHexString.of(Buffer.from(JSON.stringify(imageNote("old", PNG)), "utf8").toString("hex")));
  const [read] = readAnnotations(await PDFDocument.load(await pdf.save()));
  assert.equal(read.payload?.imageSrc, PNG);
});

test("standard annotation dictionaries have subtype, appearance and name", async () => {
  const pdf = await blank();
  await writeAnnotations(pdf, sidecar(kinds()));
  const annots = pdf.getPage(0).node.Annots()!;
  const subtypes: string[] = [];
  for (let i = 0; i < annots.size(); i++) {
    const d = annots.lookup(i, PDFDict);
    subtypes.push(d.get(PDFName.of("Subtype"))!.toString());
    assert.ok(d.has(PDFName.of("AP")), "has appearance");
    assert.equal(d.lookup(PDFName.of("F"))!.toString(), "4");
    assert.ok(d.has(PDFName.of("Rect")));
  }
  assert.deepEqual(subtypes, ["/Square", "/Circle", "/Line", "/Line", "/Ink", "/Highlight", "/Highlight", "/Underline", "/StrikeOut", "/FreeText", "/Stamp"]);
  const arrow = annots.lookup(3, PDFDict);
  assert.equal(arrow.lookup(PDFName.of("LE"), PDFArray).toString(), "[ /None /ClosedArrow ]");
  assert.equal(annots.lookup(6, PDFDict).lookup(PDFName.of("QuadPoints"), PDFArray).size(), 16);
});

test("appearance BBox is in page user space for rotated cropped pages", async () => {
  const pdf = await blank(90, true);
  await writeAnnotations(pdf, sidecar([kinds()[0]]));
  const d = pdf.getPage(0).node.Annots()!.lookup(0, PDFDict);
  const rect = d.lookup(PDFName.of("Rect"), PDFArray).asArray().map((n: any) => n.asNumber());
  // rotation 90: display (x,y) -> user (box.x + y, box.y + x); rect pad = width/2+1 = 2.
  assert.deepEqual(rect, [30 + 18, 40 + 8, 30 + 18 + 44, 40 + 8 + 34]);
  const ap = d.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N")) as any;
  assert.deepEqual(ap.dict.lookup(PDFName.of("BBox"), PDFArray).asArray().map((n: any) => n.asNumber()), rect);
});

test("strip removes only RustyPDF annotations and counts them", async () => {
  const pdf = await blank();
  const page = pdf.getPage(0);
  const foreign = pdf.context.register(pdf.context.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 10, 10] }));
  page.node.set(PDFName.of("Annots"), pdf.context.obj([foreign]));
  await writeAnnotations(pdf, sidecar(kinds()));
  const loaded = await PDFDocument.load(await pdf.save());
  assert.equal(readAnnotations(loaded).length, 11);
  assert.equal(stripAnnotations(loaded), 11);
  assert.equal(readAnnotations(loaded).length, 0);
  const annots = loaded.getPage(0).node.Annots()!;
  assert.equal(annots.size(), 1);
  assert.equal(annots.lookup(0, PDFDict).get(PDFName.of("Subtype"))!.toString(), "/Text");
  assert.equal(stripAnnotations(loaded), 0);
  const empty = await blank();
  await writeAnnotations(empty, sidecar([kinds()[0]]));
  assert.equal(stripAnnotations(empty), 1);
  assert.equal(empty.getPage(0).node.Annots(), undefined);
});

test("malformed JSON is ignored and page is derived from the host page", async () => {
  const pdf = await blank();
  pdf.addPage([100, 100]);
  await writeAnnotations(pdf, sidecar([{ ...kinds()[0], page: 1 }, kinds()[1]]));
  const bad = pdf.getPage(0).node.Annots()!.lookup(0, PDFDict);
  const { PDFHexString } = await import("pdf-lib");
  bad.set(PDFName.of("RustyPDF"), PDFHexString.of(Buffer.from("{nope").toString("hex")));
  const read = readAnnotations(await PDFDocument.load(await pdf.save()));
  assert.deepEqual(read.map((a) => [a.id, a.page]), [["r1", 1]]);
  await assert.rejects(writeAnnotations(pdf, sidecar([{ ...kinds()[0], page: 5 }])), /page/i);
});

async function pdfjs(bytes: Uint8Array) {
  if (!(Promise as any).withResolvers)
    (Promise as any).withResolvers = () => { let resolve: any, reject: any; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
  const canvas = await import("@napi-rs/canvas");
  for (const key of ["DOMMatrix", "ImageData", "Path2D"] as const) (globalThis as any)[key] = canvas[key];
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const task = getDocument({ data: bytes.slice(), useSystemFonts: false, disableFontFace: true });
  return { task, doc: await task.promise, canvas };
}

test("flattened Korean text is extractable and output stays small", async () => {
  for (const rotation of [0, 90]) {
    const pdf = await blank(rotation, rotation === 90);
    const ann: Annotation = { id: "k", page: 0, type: "text", rect: { x: 20, y: 20, w: 200, h: 40 }, style: { color: "#000000", width: 1, fontSize: 18 },
      payload: { text: "안녕하세요 한글 PDF" } };
    const bytes = await flattenPdf(await pdf.save(), sidecar([ann]));
    assert.ok(bytes.length < 1_000_000, `size ${bytes.length}`);
    const r = await pdfjs(bytes);
    try {
      const content = await (await r.doc.getPage(1)).getTextContent();
      assert.equal(content.items.filter((i: any) => "str" in i).map((i: any) => i.str).join(""), "안녕하세요 한글 PDF");
    } finally { await r.task.destroy(); }
  }
});

test("html-only text falls back to stripped html and round-trips", async () => {
  const pdf = await blank();
  const ann: Annotation = { id: "h", page: 0, type: "text", rect: { x: 20, y: 20, w: 200, h: 40 }, style: { color: "#000000", width: 1 },
    payload: { html: "<div>둘째 &amp; 줄</div>" } };
  await writeAnnotations(pdf, sidecar([ann]));
  const loaded = await PDFDocument.load(await pdf.save());
  assert.deepEqual(readAnnotations(loaded), [ann]);
});

test("flatten draws a filled arrow head and saved annotations render via PDF.js", async () => {
  const pdf = await blank();
  const arrow: Annotation = { id: "a", page: 0, type: "arrow", points: [{ x: 50, y: 300 }, { x: 150, y: 300 }], style: { color: "#000000", width: 4 } };
  const flat = await flattenPdf(await pdf.save(), sidecar([arrow]));
  const saved = await (async () => { const p = await blank(); await writeAnnotations(p, sidecar([arrow])); return p.save(); })();
  for (const bytes of [flat, saved]) {
    const r = await pdfjs(bytes);
    try {
      const page = await r.doc.getPage(1), vp = page.getViewport({ scale: 1 });
      const cv = r.canvas.createCanvas(vp.width, vp.height), ctx = cv.getContext("2d");
      ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, vp.width, vp.height);
      await page.render({ canvasContext: ctx as any, viewport: vp, annotationMode: 1 } as any).promise;
      const dark = (x: number, y: number) => ctx.getImageData(x, y, 1, 1).data[0] < 100;
      // Head spans x 114..150 with half-width 12: off-axis pixels near the base are inked, the shaft is not.
      assert.ok(dark(120, 300 - 8), "head base is filled off-axis");
      assert.ok(!dark(80, 300 - 8), "shaft is thin");
      assert.ok(dark(80, 300));
    } finally { await r.task.destroy(); }
  }
});

test("foreign annotations survive flatten", async () => {
  const pdf = await blank();
  const foreign = pdf.context.register(pdf.context.obj({ Type: "Annot", Subtype: "Text", Rect: [0, 0, 10, 10] }));
  pdf.getPage(0).node.set(PDFName.of("Annots"), pdf.context.obj([foreign]));
  const out = await PDFDocument.load(await flattenPdf(await pdf.save(), sidecar([kinds()[0]])));
  assert.equal(out.getPage(0).node.Annots()!.size(), 1);
});

test("strip leaves no orphaned fonts or images behind", async () => {
  const pdf = await blank();
  const clean = (await pdf.save()).length;
  const baseCount = pdf.context.enumerateIndirectObjects().length;
  await writeAnnotations(pdf, sidecar(kinds()));
  const loaded = await PDFDocument.load(await pdf.save());
  assert.ok(stripAnnotations(loaded) > 0);
  const after = await PDFDocument.load(await loaded.save());
  assert.equal(after.context.enumerateIndirectObjects().length, baseCount);
  assert.ok((await loaded.save()).length < clean + 200);
});

test("tiny JPEG (< 4 KB, pooled Buffer) embeds on write and flatten", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xc0, 0, 17, 8, 0, 2, 0, 2, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0, 0xff, 0xd9]);
  const src = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
  const pdf = await blank();
  await writeAnnotations(pdf, sidecar([imageNote("tiny", src)]));
  const read = readAnnotations(await PDFDocument.load(await pdf.save()));
  assert.equal(read[0].payload?.imageSrc, src);
});
