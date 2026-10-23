import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { inflateSync } from "node:zlib";
import { PDFDocument } from "pdf-lib";
import { PdfService } from "../electron/pdf-service";

const fontsDir = resolve(process.cwd(), "resources/fonts");
const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const st = { color: "#112233", width: 2 };
const kinds = (): any[] => [
  { id: "t", page: 0, type: "text", rect: { x: 20, y: 20, w: 200, h: 40 }, style: { ...st, fontSize: 18 },
    payload: { text: "안녕하세요 한글 PDF",
      layout: [{ baseline: 14, fragments: [{ text: "안녕하세요 한글 PDF", x: 0, fontSize: 18, color: "#112233", bold: false, italic: false, underline: false }] }] } },
  { id: "r", page: 0, type: "rect", rect: { x: 10, y: 80, w: 30, h: 40 }, style: { ...st, fill: "#ffee00" } },
  { id: "e", page: 0, type: "ellipse", rect: { x: 50, y: 80, w: 30, h: 40 }, style: st },
  { id: "l", page: 0, type: "line", points: [{ x: 10, y: 150 }, { x: 90, y: 160 }], style: st },
  { id: "a", page: 0, type: "arrow", points: [{ x: 10, y: 170 }, { x: 90, y: 190 }], style: st },
  { id: "p", page: 1, type: "pen", points: [{ x: 10, y: 10 }, { x: 20, y: 30 }, { x: 40, y: 20 }], style: st },
  { id: "h", page: 1, type: "highlight", rect: { x: 10, y: 50, w: 80, h: 12 }, quads: [{ x: 10, y: 50, w: 40, h: 12 }, { x: 50, y: 50, w: 40, h: 12 }], style: { color: "#ffff00", width: 1, opacity: 0.4 } },
  { id: "u", page: 1, type: "underline", rect: { x: 10, y: 70, w: 80, h: 12 }, quads: [{ x: 10, y: 70, w: 80, h: 12 }], style: st },
  { id: "s", page: 1, type: "strikeout", rect: { x: 10, y: 90, w: 80, h: 12 }, quads: [{ x: 10, y: 90, w: 80, h: 12 }], style: st },
  { id: "i", page: 1, type: "image", rect: { x: 100, y: 100, w: 40, h: 40 }, style: st,
    payload: { imageSrc: PNG, imageNaturalWidth: 1, imageNaturalHeight: 1 } },
];
const sidecar = (annotations: any[]) => ({ version: 3, annotations });
const strip = (a: any) => { const c = structuredClone(a); if (c.payload) delete c.payload.layout; return c; };
/** Decoded pixels of a 1x1 PNG data URL: the reader re-encodes PNGs, so bytes differ but pixels must not. */
const pngPixel = (src: string) => {
  const b = Buffer.from(src.slice(src.indexOf(",") + 1), "base64");
  const idat: Buffer[] = [];
  let ihdr = "";
  for (let o = 8; o < b.length; o += 12 + b.readUInt32BE(o)) {
    const len = b.readUInt32BE(o), type = b.toString("latin1", o + 4, o + 8);
    if (type === "IHDR") ihdr = b.subarray(o + 8, o + 8 + len).toString("hex");
    if (type === "IDAT") idat.push(b.subarray(o + 8, o + 8 + len));
  }
  return { ihdr, pixel: inflateSync(Buffer.concat(idat)).subarray(1).toString("hex") };
};
const noPixels = (a: any) => { const c = strip(a); if (c.type === "image") delete c.payload.imageSrc; return c; };
const byId = (l: any[]) => [...l].sort((x, y) => x.id.localeCompare(y.id));

async function setup(count = 3) {
  const dir = await mkdtemp(join(tmpdir(), "rustypdf-overhaul-"));
  const path = join(dir, "in.pdf");
  const pdf = await PDFDocument.create();
  for (let i = 0; i < count; i++) pdf.addPage([200, 300]);
  await writeFile(path, await pdf.save());
  const service = new PdfService({ dataDir: join(dir, "data"), fontsDir });
  const doc: any = await service.invoke("pdf_open", { path });
  return { dir, path, service, doc };
}
const d$ = (doc: any, extra: Record<string, unknown> = {}, rev = doc.revision) => ({ docId: doc.id, expectedRevision: rev, ...extra });

test("every annotation kind survives save, reopen and a second save", async () => {
  const { service, doc, path } = await setup();
  try {
    const saved: any = await service.invoke("pdf_save_document", d$(doc, { targetPath: path, annotations: sidecar(kinds()), includeOcr: false }));
    await service.invoke("pdf_close", { docId: doc.id });
    const re: any = await service.invoke("pdf_open", { path });
    assert.deepEqual(byId(re.annotations.map(noPixels)), byId(kinds().map(noPixels)));
    const imgSrc = (l: any[]) => l.find((a) => a.id === "i").payload.imageSrc;
    assert.deepEqual(pngPixel(imgSrc(re.annotations)), pngPixel(imgSrc(kinds())));
    const base = await service.invoke("pdf_document_bytes", d$(re, {}));
    assert.ok(!Buffer.from(base).includes("/RustyPDF"), "base bytes must be annotation-free");
    const size1 = (await stat(path)).size;
    await service.invoke("pdf_save_document", d$(re, { targetPath: path, annotations: sidecar(re.annotations), includeOcr: false }));
    await service.invoke("pdf_close", { docId: re.id });
    const re2: any = await service.invoke("pdf_open", { path });
    assert.equal(re2.annotations.length, kinds().length);
    const size2 = (await stat(path)).size;
    assert.ok(size2 <= size1 * 1.05 + 2048, `grew ${size1} -> ${size2}`);
    assert.ok(saved.revision >= 1);
  } finally { await service.dispose(); }
});

test("move and delete pages keep OCR remapped", async () => {
  const { service, doc } = await setup();
  const state = (service as any).documents.get(doc.id);
  const mk = (t: string) => ({ text: t, lines: [{ text: t, x: 0.1, y: 0.1, w: 0.5, h: 0.1 }] });
  state.ocr.set(0, mk("zero"));
  state.ocr.set(2, mk("two"));
  try {
    const moved: any = await service.invoke("pdf_move_pages", d$(doc, { indices: [0], toIndex: 2 }));
    const status = (await service.invoke("pdf_ocr_status", d$(doc, {}, moved.revision))) as number[];
    assert.equal(status.length, 2);
    const all: any = await service.invoke("pdf_ocr_all_lines", d$(doc, {}, moved.revision));
    const texts = Object.values(all).map((l: any) => l[0].text).sort();
    assert.deepEqual(texts, ["two", "zero"]);
    const del: any = await service.invoke("pdf_delete_pages", d$(doc, { indices: [1] }, moved.revision));
    const after: any = await service.invoke("pdf_ocr_all_lines", d$(doc, {}, del.revision));
    assert.ok(Object.keys(after).every((k) => Number(k) < del.pageCount));
  } finally { await service.dispose(); }
});

test("encrypted open rejects save with the Korean message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rustypdf-overhaul-enc-"));
  const path = join(dir, "enc.pdf");
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  pdf.context.trailerInfo.Encrypt = pdf.context.register(pdf.context.obj({ Filter: "Standard", V: 1, R: 2 }));
  await writeFile(path, await pdf.save());
  const service = new PdfService({ dataDir: join(dir, "data"), fontsDir });
  try {
    const doc: any = await service.invoke("pdf_open", { path });
    assert.equal(doc.readOnly, true);
    await assert.rejects(service.invoke("pdf_save_document", d$(doc, { targetPath: path, annotations: sidecar([]), includeOcr: false })), /암호화된 PDF는 읽기 전용/);
  } finally { await service.dispose(); }
});

test("pdf_flatten_bytes output text is extractable by PDF.js", async () => {
  const { service, doc } = await setup(1);
  try {
    if (!(Promise as any).withResolvers)
      (Promise as any).withResolvers = () => { let resolve: any, reject: any; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
    const canvas = await import("@napi-rs/canvas");
    for (const key of ["DOMMatrix", "ImageData", "Path2D"] as const) (globalThis as any)[key] = canvas[key];
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const bytes: Uint8Array = (await service.invoke("pdf_flatten_bytes", d$(doc, { data: sidecar([kinds()[0]]), includeOcr: false }))) as any;
    const task = getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true });
    try {
      const content = await (await (await task.promise).getPage(1)).getTextContent();
      assert.equal(content.items.filter((i: any) => "str" in i).map((i: any) => i.str).join(""), "안녕하세요 한글 PDF");
    } finally { await task.destroy(); }
  } finally { await service.dispose(); }
});
