import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import { PdfService } from "../electron/pdf-service";
import { aliasName, loadLegacy } from "../electron/annotation-store";
import { fingerprint } from "../electron/storage";

async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "rustypdf-integration-"));
  const path = join(dir, "source.pdf");
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  pdf.addPage([400, 500]);
  const bytes = await pdf.save();
  await writeFile(path, bytes);
  return { dir, path, bytes, dataDir: join(dir, "data") };
}
const rect = (id = "annotation", page = 1) => ({
  id,
  page,
  type: "rect",
  rect: { x: 20, y: 30, w: 40, h: 50 },
  style: { color: "#123456", width: 2 },
});
const args = (doc: { id: string; revision: number }, extra: object = {}) => ({
  docId: doc.id,
  expectedRevision: doc.revision,
  ...extra,
});

test("editable lifecycle survives page edit, save, close and reopen", async () => {
  const f = await fixture();
  const service = new PdfService({ dataDir: f.dataDir });
  try {
    const opened: any = await service.invoke("pdf_open", { path: f.path });
    const rotated: any = await service.invoke("pdf_rotate_pages", args(opened, { indices: [1], direction: 1 }));
    assert.deepEqual(rotated.pageMapping, [0, 1]);
    const saved: any = await service.invoke(
      "pdf_save_document",
      args(rotated, {
        targetPath: f.path,
        annotations: { version: 3, annotations: [rect()] },
        includeOcr: false,
      }),
    );
    assert.equal(saved.revision, 2);
    const disk = await PDFDocument.load(await readFile(f.path));
    assert.equal(disk.getPage(1).getRotation().angle, 90);
    await service.invoke("pdf_close", { docId: opened.id });
    const reopened: any = await service.invoke("pdf_open", { path: f.path });
    assert.equal(reopened.revision, 0);
    assert.deepEqual(reopened.pages[1], { index: 1, width: 500, height: 400, rotation: 90 });
    assert.equal(reopened.annotations.length, 1);
    assert.equal(reopened.annotations[0].id, "annotation");
    assert.deepEqual(reopened.annotations[0].rect, rect().rect);
  } finally {
    await service.dispose();
  }
});

test("OCR cache reloads from userData including empty pages; changed bytes invalidate it", async () => {
  const f = await fixture();
  const first = { text: "cached", lines: [{ text: "cached", x: 0.1, y: 0.2, w: 0.3, h: 0.1 }] };
  const service = new PdfService({ dataDir: f.dataDir });
  try {
    const opened: any = await service.invoke("pdf_open", { path: f.path });
    const state = (service as any).documents.get(opened.id);
    state.ocr.set(0, first);
    state.ocr.set(1, { text: "", lines: [] });
    state.ocrDirty = true;
    await service.invoke("pdf_close", { docId: opened.id });
    const again: any = await service.invoke("pdf_open", { path: f.path });
    assert.deepEqual(await service.invoke("pdf_ocr_status", args(again)), [0, 1]);
    assert.deepEqual(await service.invoke("pdf_ocr_lines", args(again, { pageIndex: 1 })), []);
    await service.invoke("pdf_close", { docId: again.id });
    const replacement = await PDFDocument.create();
    replacement.addPage([700, 800]);
    await writeFile(f.path, await replacement.save());
    const changed: any = await service.invoke("pdf_open", { path: f.path });
    assert.deepEqual(await service.invoke("pdf_ocr_status", args(changed)), []);
    assert.equal(await service.invoke("pdf_ocr_lines", args(changed, { pageIndex: 0 })), null);
  } finally {
    await service.dispose();
  }
});

test("legacy <pdf>.ocr.json is read once and never rewritten", async () => {
  const f = await fixture();
  const legacyPath = `${f.path}.ocr.json`;
  const body = JSON.stringify({
    version: 2,
    pdfFingerprint: fingerprint(f.bytes),
    documentRevision: 9,
    pages: { 0: { text: "old", lines: [{ text: "old", x: 0.1, y: 0.2, w: 0.3, h: 0.1 }] }, 9: { text: "bad", lines: [] } },
  });
  await writeFile(legacyPath, body);
  const service = new PdfService({ dataDir: f.dataDir });
  try {
    const opened: any = await service.invoke("pdf_open", { path: f.path });
    assert.deepEqual(await service.invoke("pdf_ocr_status", args(opened)), [0]);
    await service.invoke("pdf_close", { docId: opened.id });
    assert.equal(await readFile(legacyPath, "utf8"), body);
  } finally {
    await service.dispose();
  }
});

test("unfingerprinted legacy OCR is ignored", async () => {
  const f = await fixture();
  await writeFile(`${f.path}.ocr.json`, JSON.stringify({ 0: { text: "unsafe legacy", lines: [] } }));
  const service = new PdfService({ dataDir: f.dataDir });
  try {
    const opened: any = await service.invoke("pdf_open", { path: f.path });
    assert.deepEqual(await service.invoke("pdf_ocr_status", args(opened)), []);
  } finally {
    await service.dispose();
  }
});

test("legacy sidecar in an old data directory loads read-only for a moved PDF", async () => {
  const f = await fixture();
  const legacyDir = join(f.dir, "old-app");
  const root = join(legacyDir, "annotations");
  const hash = fingerprint(f.bytes);
  await mkdir(join(root, "documents", hash), { recursive: true });
  const sidecar = {
    version: 2,
    sourcePath: f.path,
    pdfFingerprint: hash,
    documentKey: "integration-owner",
    annotations: [rect("old")],
  };
  await writeFile(join(root, "documents", hash, "integration-owner.notes.json"), JSON.stringify(sidecar));
  await writeFile(join(root, aliasName(f.path)), JSON.stringify(sidecar));
  const moved = join(f.dir, "moved.pdf");
  await rename(f.path, moved);
  const service = new PdfService({ dataDir: f.dataDir, legacyDataDirs: [legacyDir] });
  try {
    const opened: any = await service.invoke("pdf_open", { path: moved });
    assert.equal(opened.annotations, null);
    assert.equal(opened.legacy.annotations[0].id, "old");
    // A later identical copy is not linked automatically.
    const copy = join(f.dir, "copy.pdf");
    await writeFile(copy, f.bytes);
    const copied = await loadLegacy(copy, f.bytes, [root]);
    assert.equal(copied?.annotations[0].id ?? null, "old", "moved owner is unique while the source is missing");
    await writeFile(f.path, f.bytes);
    assert.equal(await loadLegacy(copy, f.bytes, [root]), null, "ambiguous once the source exists again");
  } finally {
    await service.dispose();
  }
});
