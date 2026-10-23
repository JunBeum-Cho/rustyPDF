import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import {
  applyPageEdit,
  extractPages,
  mergePdfFiles,
} from "../electron/page-ops.js";
import { createPdfFromImages, orientationMatrix } from "../electron/image-pdf.js";

async function doc(widths: number[]) {
  const pdf = await PDFDocument.create();
  for (const w of widths) pdf.addPage([w, 100]);
  return pdf.save();
}
async function widths(bytes: Uint8Array) {
  return (await PDFDocument.load(bytes)).getPages().map((p) => p.getWidth());
}
const apply = (b: Uint8Array, op: any) => applyPageEdit(b, op);

test("move to front", async () => {
  const r = await apply(await doc([100, 200, 300]), { kind: "move", indices: [2], toIndex: 0 });
  assert.deepEqual(r.mapping, [1, 2, 0]);
  assert.deepEqual(r.pages.map((p) => p.width), [300, 100, 200]);
  assert.deepEqual(r.pages.map((p) => p.index), [0, 1, 2]);
  assert.deepEqual(await widths(r.bytes), [300, 100, 200]);
});
test("move to the end keeps relative order", async () => {
  const r = await apply(await doc([100, 200, 300, 400]), { kind: "move", indices: [0, 1], toIndex: 2 });
  assert.deepEqual(r.mapping, [2, 3, 0, 1]);
  assert.deepEqual(await widths(r.bytes), [300, 400, 100, 200]);
  assert.deepEqual(r.pages.map((p) => p.width), [300, 400, 100, 200]);
});
test("delete mapping", async () => {
  const r = await apply(await doc([100, 200, 300]), { kind: "delete", indices: [1] });
  assert.deepEqual(r.mapping, [0, null, 1]);
  assert.deepEqual(r.rotated, []);
  assert.deepEqual(r.pages.map((p) => p.width), [100, 300]);
  assert.deepEqual(await widths(r.bytes), [100, 300]);
  await assert.rejects(apply(await doc([100]), { kind: "delete", indices: [0] }));
});
test("duplicate after last selected", async () => {
  const r = await apply(await doc([100, 200, 300]), { kind: "duplicate", indices: [0, 1] });
  assert.deepEqual(r.mapping, [0, 1, 4]);
  assert.deepEqual(await widths(r.bytes), [100, 200, 100, 200, 300]);
  assert.deepEqual(r.pages.map((p) => p.width), [100, 200, 100, 200, 300]);
});
test("rotate lists indices", async () => {
  const r = await apply(await doc([100, 200]), { kind: "rotate", indices: [1], direction: -1 });
  assert.deepEqual(r.mapping, [0, 1]);
  assert.deepEqual(r.rotated, [1]);
  assert.equal(r.pages[1].rotation, 270);
  assert.equal(r.pages[1].width, 100);
});
test("insert at -1 and after", async () => {
  const src = await doc([700, 800]);
  const r = await apply(await doc([100, 200]), { kind: "insert", afterIndex: -1, sourceBytes: src });
  assert.deepEqual(r.mapping, [2, 3]);
  assert.deepEqual(await widths(r.bytes), [700, 800, 100, 200]);
  assert.deepEqual(r.pages.map((p) => p.width), [700, 800, 100, 200]);
  const r2 = await apply(await doc([100, 200]), { kind: "insert", afterIndex: 0, sourceBytes: src });
  assert.deepEqual(r2.mapping, [0, 3]);
  assert.deepEqual(await widths(r2.bytes), [100, 700, 800, 200]);
});
test("extract and merge", async () => {
  const b = await doc([100, 200, 300]);
  assert.deepEqual(await widths(await extractPages(b, [2, 0])), [300, 100]);
  const dir = await mkdtemp(join(tmpdir(), "po-"));
  await writeFile(join(dir, "a.pdf"), b);
  await writeFile(join(dir, "b.pdf"), await doc([400]));
  assert.deepEqual(await widths(await mergePdfFiles([join(dir, "a.pdf"), join(dir, "b.pdf")])), [100, 200, 300, 400]);
});
test("orientation 5 and 7 matrices place the top-left pixel correctly", () => {
  const W = 4, H = 2;
  const ap = (m: number[], x: number, y: number) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  // Source top-left is (0,H). Transpose (5): displays at top-left (0,W). Transverse (7): bottom-right (H,0).
  assert.deepEqual(ap(orientationMatrix(5, W, H), 0, H), [0, W]);
  assert.deepEqual(ap(orientationMatrix(5, W, H), W, 0), [H, 0]);
  assert.deepEqual(ap(orientationMatrix(7, W, H), 0, H), [H, 0]);
  assert.deepEqual(ap(orientationMatrix(7, W, H), W, 0), [0, W]);
});
test("createPdfFromImages makes one page per image", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  const dir = await mkdtemp(join(tmpdir(), "po-"));
  const p = join(dir, "a.png");
  await writeFile(p, png);
  assert.equal((await PDFDocument.load(await createPdfFromImages([p, p]))).getPageCount(), 2);
});
test("createPdfFromImages handles tiny JPEG with pooled buffer offset", async () => {
  const jpg = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=", "base64");
  const dir = await mkdtemp(join(tmpdir(), "po-"));
  const p = join(dir, "t.jpg");
  await writeFile(p, jpg);
  Buffer.allocUnsafe(37);
  assert.equal((await PDFDocument.load(await createPdfFromImages([p]))).getPageCount(), 1);
});
