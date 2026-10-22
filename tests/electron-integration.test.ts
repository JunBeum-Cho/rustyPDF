import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rename,
  copyFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PDFDocument } from "pdf-lib";
import { PdfService } from "../electron/pdf-service";
import { AnnotationStore } from "../electron/annotation-store";
import { fingerprint } from "../electron/storage";
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), "rustypdf-integration-"));
  const path = join(dir, "source.pdf");
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  pdf.addPage([400, 500]);
  const bytes = await pdf.save();
  await writeFile(path, bytes);
  const dataDir = join(dir, "data");
  return { dir, path, bytes, dataDir };
}
const sidecar = (path: string, id = "annotation") => ({
  version: 2,
  sourcePath: path,
  documentKey: "integration-owner",
  updatedAt: "2026-10-21T00:00:00Z",
  annotations: [
    {
      id,
      page: 1,
      type: "rect",
      rect: { x: 20, y: 30, w: 40, h: 50 },
      style: { color: "#123456", width: 2 },
    },
  ],
});
test("editable lifecycle survives page edit, save, close and reopen", async () => {
  const f = await fixture();
  const service = new PdfService({ dataDir: f.dataDir });
  try {
    const opened: any = await service.invoke("pdf_open", { path: f.path });
    const initial = sidecar(f.path);
    await service.invoke("annotations_save", {
      docId: opened.id,
      expectedRevision: 0,
      path: f.path,
      data: initial,
    });
    const rotated: any = await service.invoke("pdf_rotate_pages", {
      docId: opened.id,
      expectedRevision: 0,
      indices: [1],
      direction: 1,
    });
    assert.deepEqual(rotated.pageMapping, [0, 1]);
    const mapped = {
      ...initial,
      documentRevision: rotated.revision + 1,
      pageLayout: rotated.pages,
      annotations: initial.annotations.map((a) => ({
        ...a,
        page: rotated.pageMapping[a.page],
        rect: { x: 420, y: 20, w: 50, h: 40 },
      })),
    };
    const saved: any = await service.invoke("pdf_save_document", {
      docId: opened.id,
      expectedRevision: 1,
      targetPath: f.path,
      sidecar: mapped,
    });
    assert.equal(saved.revision, 2);
    assert.deepEqual(
      Buffer.from(
        await service.invoke("pdf_document_bytes", {
          docId: opened.id,
          expectedRevision: 2,
        }),
      ),
      await readFile(f.path),
    );
    await assert.rejects(
      service.invoke("pdf_document_bytes", {
        docId: opened.id,
        expectedRevision: 1,
      }),
      /revision/i,
    );
    await service.invoke("pdf_close", { docId: opened.id });
    const reopened: any = await service.invoke("pdf_open", { path: f.path });
    assert.equal(reopened.revision, 0);
    assert.deepEqual(reopened.pages[1], {
      index: 1,
      width: 500,
      height: 400,
      rotation: 90,
    });
    const loaded: any = await service.invoke("annotations_load", {
      docId: reopened.id,
      expectedRevision: 0,
      path: f.path,
    });
    assert.equal(loaded.status, "exact");
    assert.deepEqual(loaded.sidecar.annotations, mapped.annotations);
    const disk = await PDFDocument.load(await readFile(f.path));
    assert.equal(disk.getPage(1).getRotation().angle, 90);
  } finally {
    await service.dispose();
  }
});
test("OCR v2 fingerprint cache reloads including valid empty pages, external bytes invalidate it", async () => {
  const f = await fixture();
  await writeFile(
    `${f.path}.ocr.json`,
    JSON.stringify({
      version: 2,
      pdfFingerprint: fingerprint(f.bytes),
      documentRevision: 99,
      pages: {
        0: {
          text: "cached",
          lines: [{ text: "cached", x: 0.1, y: 0.2, w: 0.3, h: 0.1 }],
        },
        1: { text: "", lines: [] },
        9: { text: "invalid page", lines: [] },
      },
    }),
  );
  const service = new PdfService({ dataDir: f.dataDir });
  try {
    const opened: any = await service.invoke("pdf_open", { path: f.path });
    assert.deepEqual(
      await service.invoke("pdf_ocr_status", {
        docId: opened.id,
        expectedRevision: 0,
      }),
      [0, 1],
    );
    assert.deepEqual(
      await service.invoke("pdf_ocr_lines", {
        docId: opened.id,
        expectedRevision: 0,
        pageIndex: 1,
      }),
      [],
    );
    await service.invoke("pdf_close", { docId: opened.id });
    const replacement = await PDFDocument.create();
    replacement.addPage([700, 800]);
    await writeFile(f.path, await replacement.save());
    const changed: any = await service.invoke("pdf_open", { path: f.path });
    assert.deepEqual(
      await service.invoke("pdf_ocr_status", {
        docId: changed.id,
        expectedRevision: 0,
      }),
      [],
    );
    assert.equal(
      await service.invoke("pdf_ocr_lines", {
        docId: changed.id,
        expectedRevision: 0,
        pageIndex: 0,
      }),
      null,
    );
  } finally {
    await service.dispose();
  }
});
test("unfingerprinted legacy OCR is ignored", async () => {
  const f = await fixture();
  await writeFile(
    `${f.path}.ocr.json`,
    JSON.stringify({ 0: { text: "unsafe legacy", lines: [] } }),
  );
  const service = new PdfService({ dataDir: f.dataDir });
  try {
    const opened: any = await service.invoke("pdf_open", { path: f.path });
    assert.deepEqual(
      await service.invoke("pdf_ocr_status", {
        docId: opened.id,
        expectedRevision: 0,
      }),
      [],
    );
  } finally {
    await service.dispose();
  }
});
test("legacy data directory migrates and moved ownership cannot attach to later copies", async () => {
  const f = await fixture();
  const legacy = join(f.dir, "old-app");
  const oldStore = new AnnotationStore(join(legacy, "annotations"));
  await oldStore.save(f.path, f.bytes, sidecar(f.path));
  const moved = join(f.dir, "moved.pdf");
  await rename(f.path, moved);
  const service = new PdfService({
    dataDir: f.dataDir,
    legacyDataDirs: [legacy],
  });
  try {
    const opened: any = await service.invoke("pdf_open", { path: moved });
    const recovered: any = await service.invoke("annotations_load", {
      docId: opened.id,
      expectedRevision: 0,
      path: moved,
    });
    assert.equal(recovered.status, "recovered");
    assert.equal(recovered.sidecar.sourcePath, moved);
    await service.invoke("pdf_close", { docId: opened.id });
    const copy = join(f.dir, "copy.pdf");
    await copyFile(moved, copy);
    const copied: any = await service.invoke("pdf_open", { path: copy });
    const rejected: any = await service.invoke("annotations_load", {
      docId: copied.id,
      expectedRevision: 0,
      path: copy,
    });
    assert.equal(rejected.status, "ambiguous");
    assert.equal(rejected.sidecar, null);
    const current = new AnnotationStore(join(f.dataDir, "annotations"));
    assert.equal((await current.load(moved, f.bytes)).status, "exact");
    const old = new AnnotationStore(join(legacy, "annotations"));
    assert.equal((await old.load(copy, f.bytes)).sidecar, null);
  } finally {
    await service.dispose();
  }
});
test("durable staged sidecar wins stale alias after interrupted alias publication", async () => {
  const f = await fixture();
  const store = new AnnotationStore(join(f.dataDir, "annotations"));
  await store.save(f.path, f.bytes, sidecar(f.path, "old"));
  await store.stage(f.path, f.bytes, sidecar(f.path, "new-durable"));
  const service = new PdfService({ dataDir: f.dataDir });
  try {
    const opened: any = await service.invoke("pdf_open", { path: f.path });
    const loaded: any = await service.invoke("annotations_load", {
      docId: opened.id,
      expectedRevision: 0,
      path: f.path,
    });
    assert.equal(loaded.status, "exact");
    assert.equal(loaded.sidecar.annotations[0].id, "new-durable");
  } finally {
    await service.dispose();
  }
});
