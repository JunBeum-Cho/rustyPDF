import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFArray, PDFDict, PDFDocument, PDFName, degrees } from "pdf-lib";
import { PdfService } from "../electron/pdf-service";
import { readAnnotations } from "../electron/pdf-annotations";
import { aliasName } from "../electron/annotation-store";
import { fingerprint } from "../electron/storage";

const READ_ONLY = /암호화된 PDF는 읽기 전용/;
const rect = (id = "r1", page = 0) => ({
  id,
  page,
  type: "rect",
  rect: { x: 10, y: 20, w: 30, h: 40 },
  style: { color: "#ff0000", width: 2 },
});
const sidecar = (...annotations: any[]) => ({ version: 3, annotations });

async function pdfBytes(count = 3, mutate?: (pdf: PDFDocument) => void) {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < count; i++) pdf.addPage([200 + i * 10, 300]);
  mutate?.(pdf);
  return pdf.save();
}
async function fixture(count = 3, mutate?: (pdf: PDFDocument) => void) {
  const dir = await mkdtemp(join(tmpdir(), "rustypdf-service-"));
  const path = join(dir, "input.pdf");
  await writeFile(path, await pdfBytes(count, mutate));
  const events: Array<[string, unknown]> = [];
  const service = new PdfService({ dataDir: join(dir, "data") }, (e, p) =>
    events.push([e, p]),
  );
  const doc: any = await service.invoke("pdf_open", { path });
  return { dir, path, service, doc, events };
}
const doc$ = (doc: any, extra: Record<string, unknown> = {}, rev = doc.revision) => ({
  docId: doc.id,
  expectedRevision: rev,
  ...extra,
});

test("stale revision rejected; rotation and page mapping persist", async () => {
  const { service, doc } = await fixture();
  try {
    assert.equal(doc.readOnly, false);
    assert.equal(doc.readOnlyReason, null);
    assert.equal(doc.signed, false);
    assert.equal(doc.annotations, null);
    assert.equal(doc.legacy, null);
    const rotated: any = await service.invoke("pdf_rotate_pages", doc$(doc, { indices: [0], direction: 1 }));
    assert.deepEqual(rotated.pages[0], { index: 0, width: 300, height: 200, rotation: 90 });
    await assert.rejects(service.invoke("pdf_document_bytes", doc$(doc, {}, 0)), /revision|stale/i);
    await service.invoke("pdf_document_bytes", doc$(doc, {}, 1));
    const deleted: any = await service.invoke("pdf_delete_pages", doc$(doc, { indices: [1] }, 1));
    assert.deepEqual(deleted.pageMapping, [0, null, 1]);
    await assert.rejects(service.invoke("pdf_delete_pages", doc$(doc, { indices: [0, 1] }, 2)));
  } finally {
    await service.dispose();
  }
});

test("save then re-open returns editable annotations and a stripped base", async () => {
  const { service, doc, path } = await fixture();
  try {
    const saved: any = await service.invoke(
      "pdf_save_document",
      doc$(doc, { targetPath: path, annotations: sidecar(rect()), includeOcr: false }),
    );
    assert.equal(saved.revision, 1);
    const onDisk = await PDFDocument.load(await readFile(path));
    assert.equal(readAnnotations(onDisk).length, 1);
    // Base bytes stay annotation-free after the save.
    const base = await service.invoke("pdf_document_bytes", doc$(doc, {}, 1));
    assert.equal(readAnnotations(await PDFDocument.load(base)).length, 0);
    await service.invoke("pdf_close", { docId: doc.id });
    const reopened: any = await service.invoke("pdf_open", { path });
    assert.equal(reopened.annotations.length, 1);
    assert.equal(reopened.annotations[0].id, "r1");
    assert.equal(reopened.legacy, null);
    assert.equal(reopened.readOnly, false);
    const base2 = await service.invoke("pdf_document_bytes", doc$(reopened));
    assert.equal(readAnnotations(await PDFDocument.load(base2)).length, 0);
  } finally {
    await service.dispose();
  }
});

test("stripped base keeps foreign annotations", async () => {
  const { service, doc, path } = await fixture(1, (pdf) => {
    const ctx = pdf.context;
    const link = ctx.register(
      ctx.obj({
        Type: "Annot",
        Subtype: "Link",
        Rect: [0, 0, 50, 20],
        Border: [0, 0, 0],
      }),
    );
    pdf.getPage(0).node.set(PDFName.of("Annots"), ctx.obj([link]));
  });
  try {
    await service.invoke(
      "pdf_save_document",
      doc$(doc, { targetPath: path, annotations: sidecar(rect()), includeOcr: false }),
    );
    await service.invoke("pdf_close", { docId: doc.id });
    const reopened: any = await service.invoke("pdf_open", { path });
    assert.equal(reopened.annotations.length, 1);
    const base = await PDFDocument.load(
      await service.invoke("pdf_document_bytes", doc$(reopened)),
    );
    const annots = base.getPage(0).node.lookup(PDFName.of("Annots"), PDFArray);
    assert.equal(annots.size(), 1);
    assert.equal(
      (annots.lookup(0, PDFDict).get(PDFName.of("Subtype")) as PDFName).asString(),
      "/Link",
    );
  } finally {
    await service.dispose();
  }
});

test("encrypted PDF opens read-only and rejects every edit", async () => {
  const dir = await mkdtemp(join(tmpdir(), "rustypdf-enc-"));
  const path = join(dir, "enc.pdf");
  const pdf = await PDFDocument.create();
  pdf.addPage([200, 300]);
  pdf.addPage([200, 300]);
  const enc = pdf.context.register(pdf.context.obj({ Filter: "Standard", V: 1, R: 2 }));
  pdf.context.trailerInfo.Encrypt = enc;
  await writeFile(path, await pdf.save());
  const service = new PdfService({ dataDir: join(dir, "data") });
  try {
    const doc: any = await service.invoke("pdf_open", { path });
    assert.equal(doc.readOnly, true);
    assert.equal(doc.readOnlyReason, "encrypted");
    assert.equal(doc.pageCount, 2);
    const a = doc$(doc);
    for (const [command, extra] of [
      ["pdf_delete_pages", { indices: [0] }],
      ["pdf_rotate_pages", { indices: [0], direction: 1 }],
      ["pdf_move_pages", { indices: [0], toIndex: 1 }],
      ["pdf_save_document", { targetPath: path, annotations: sidecar(), includeOcr: false }],
      ["export_annotated_pdf", { targetPath: join(dir, "out.pdf"), data: sidecar() }],
      ["pdf_flatten_bytes", { data: sidecar(), includeOcr: false }],
      ["pdf_apply_form_bytes", { bytes: new Uint8Array([1]) }],
    ] as const)
      await assert.rejects(service.invoke(command, { ...a, ...extra }), READ_ONLY, command);
    // The original (still encrypted) bytes are served unchanged.
    assert.deepEqual(
      Buffer.from(await service.invoke("pdf_document_bytes", a)),
      await readFile(path),
    );
  } finally {
    await service.dispose();
  }
});

test("unparsable file reports a Korean error", async () => {
  const { service, dir } = await fixture();
  try {
    const bad = join(dir, "bad.pdf");
    await writeFile(bad, "not a pdf");
    await assert.rejects(service.invoke("pdf_open", { path: bad }), /PDF를 해석할 수 없습니다/);
  } finally {
    await service.dispose();
  }
});

test("signed PDF is detected from a /Sig field value", async () => {
  const { service, doc } = await fixture(1, (pdf) => {
    const ctx = pdf.context;
    const field = ctx.register(
      ctx.obj({ FT: "Sig", T: "sig", V: ctx.obj({ Type: "Sig", Filter: "Adobe.PPKLite" }) }),
    );
    pdf.catalog.set(PDFName.of("AcroForm"), ctx.obj({ Fields: [field], SigFlags: 3 }));
  });
  try {
    assert.equal(doc.signed, true);
  } finally {
    await service.dispose();
  }
});

test("requireCurrentPath rejects other targets and accepts the current path", async () => {
  const { service, doc, path, dir } = await fixture();
  try {
    const other = join(dir, "other.pdf");
    await assert.rejects(
      service.invoke(
        "pdf_save_document",
        doc$(doc, { targetPath: other, annotations: sidecar(), includeOcr: false, requireCurrentPath: true }),
      ),
      /현재 위치/,
    );
    await assert.rejects(readFile(other), /ENOENT/);
    const saved: any = await service.invoke(
      "pdf_save_document",
      doc$(doc, { targetPath: path, annotations: sidecar(), includeOcr: false, requireCurrentPath: true }),
    );
    assert.equal(saved.path, path);
    // Without the flag, Save As moves the document to the new path.
    const as: any = await service.invoke(
      "pdf_save_document",
      doc$(doc, { targetPath: other, annotations: sidecar(), includeOcr: false }, 1),
    );
    assert.equal(as.path, other);
    assert.equal(as.revision, 2);
    assert.equal((await PDFDocument.load(await readFile(other))).getPageCount(), 3);
  } finally {
    await service.dispose();
  }
});

test("external modification rejects save and is announced by the watcher", async () => {
  const { service, doc, path, events } = await fixture();
  try {
    await writeFile(path, "external edit");
    await assert.rejects(
      service.invoke(
        "pdf_save_document",
        doc$(doc, { targetPath: path, annotations: sidecar(), includeOcr: false }),
      ),
      /다른 프로그램이 이 PDF를 수정/,
    );
    assert.equal(await readFile(path, "utf8"), "external edit");
    for (let i = 0; i < 60 && !events.length; i++)
      await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(events[0], ["document-changed-on-disk", { docId: doc.id }]);
  } finally {
    await service.dispose();
  }
});

test("move, insert, paste, extract and merge commands", async () => {
  const { service, doc, path, dir } = await fixture();
  try {
    const moved: any = await service.invoke("pdf_move_pages", doc$(doc, { indices: [2], toIndex: 0 }));
    assert.deepEqual(moved.pageMapping, [1, 2, 0]);
    assert.equal(moved.pages[0].width, 220);
    assert.equal(typeof moved.historyToken, "string");

    const other = join(dir, "other.pdf");
    const o = await PDFDocument.create();
    o.addPage([500, 500]);
    o.addPage([600, 600]);
    await writeFile(other, await o.save());
    const inserted: any = await service.invoke("pdf_insert_file", doc$(doc, { path: other, afterIndex: -1 }, 1));
    assert.equal(inserted.pageCount, 5);
    assert.equal(inserted.pages[0].width, 500);
    assert.deepEqual(inserted.pageMapping, [2, 3, 4]);

    const clip = await service.invoke("pdf_copy_pages", doc$(doc, { indices: [0, 1] }, 2));
    const pasted: any = await service.invoke("pdf_paste_pages", doc$(doc, { afterIndex: 4, clipboardId: clip }, 2));
    assert.equal(pasted.pageCount, 7);
    await assert.rejects(service.invoke("pdf_paste_pages", doc$(doc, { afterIndex: 9, clipboardId: clip }, 3)));

    const extracted: any = await service.invoke("pdf_extract_pages", doc$(doc, { indices: [0, 6], name: "추출" }, 3));
    assert.equal(extracted.pageCount, 2);
    assert.match(extracted.path, /^unsaved:\/\/.*추출\.pdf$/);
    assert.equal(extracted.revision, 0);

    const merged: any = await service.invoke("pdf_merge_files", { paths: [path, other], name: "합본" });
    assert.equal(merged.pageCount, 5);
    assert.equal(merged.readOnly, false);
    await assert.rejects(service.invoke("pdf_merge_files", { paths: [path], name: "x" }));
  } finally {
    await service.dispose();
  }
});

test("image PDF preserves order and orientation", async () => {
  const { service, dir } = await fixture();
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAIAAAAlV+npAAAAgUlEQVR4nO3QQQ0AIAzAwPk3DRbWFyG5U9B0DmvzOuAnZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFF2jSYM8m2Qt/AAAAAElFTkSuQmCC",
      "base64",
    );
    const first = join(dir, "first.png"), second = join(dir, "second.png");
    await writeFile(first, png);
    await writeFile(second, png);
    const opened: any = await service.invoke("pdf_create_from_images", {
      paths: [first, second],
      name: "테스트.pdf",
    });
    assert.equal(opened.pageCount, 2);
    assert.match(opened.path, /unsaved:\/\/.*테스트\.pdf/);
    assert.ok(Math.abs(opened.pages[0].width - 841.8898) < 0.01);
  } finally {
    await service.dispose();
  }
});

test("OCR is remapped after delete and restored by undo", async () => {
  const { service, doc } = await fixture();
  const state = (service as any).documents.get(doc.id);
  const mk = (t: string) => ({ text: t, lines: [{ text: t, x: 0.1, y: 0.1, w: 0.5, h: 0.1 }] });
  state.ocr.set(0, mk("zero"));
  state.ocr.set(2, mk("two"));
  try {
    const edit: any = await service.invoke("pdf_delete_pages", doc$(doc, { indices: [1] }));
    assert.deepEqual(await service.invoke("pdf_ocr_status", doc$(doc, {}, 1)), [0, 1]);
    assert.equal(((await service.invoke("pdf_ocr_lines", doc$(doc, { pageIndex: 1 }, 1))) as any)[0].text, "two");
    const all = await service.invoke("pdf_ocr_all_lines", doc$(doc, {}, 1));
    assert.deepEqual(Object.keys(all), ["0", "1"]);
    const restored: any = await service.invoke("pdf_restore_snapshot", doc$(doc, { token: edit.historyToken }, 1));
    assert.equal(restored.pageCount, 3);
    assert.deepEqual(await service.invoke("pdf_ocr_status", doc$(doc, {}, 2)), [0, 2]);
    const redone: any = await service.invoke("pdf_restore_snapshot", doc$(doc, { token: edit.historyToken }, 2));
    assert.equal(redone.pageCount, 2);
    assert.deepEqual(await service.invoke("pdf_ocr_status", doc$(doc, {}, 3)), [0, 1]);
    assert.ok(redone.retainedHistoryTokens.includes(edit.historyToken));
  } finally {
    await service.dispose();
  }
});

test("rotating a page drops its OCR", async () => {
  const { service, doc } = await fixture();
  (service as any).documents.get(doc.id).ocr.set(0, { text: "a", lines: [] });
  try {
    await service.invoke("pdf_rotate_pages", doc$(doc, { indices: [0], direction: 1 }));
    assert.deepEqual(await service.invoke("pdf_ocr_status", doc$(doc, {}, 1)), []);
  } finally {
    await service.dispose();
  }
});

test("history restores bytes, bounds snapshots to 20 and expires old tokens", async () => {
  const { service, doc } = await fixture();
  try {
    const original = await service.invoke("pdf_document_bytes", doc$(doc));
    const edit: any = await service.invoke("pdf_delete_pages", doc$(doc, { indices: [1] }));
    await assert.rejects(service.invoke("pdf_restore_snapshot", doc$(doc, { token: edit.historyToken }, 0)), /revision/i);
    const restored: any = await service.invoke("pdf_restore_snapshot", doc$(doc, { token: edit.historyToken }, 1));
    assert.equal(restored.pageCount, 3);
    assert.deepEqual(await service.invoke("pdf_document_bytes", doc$(doc, {}, 2)), original);
    const redone: any = await service.invoke("pdf_restore_snapshot", doc$(doc, { token: edit.historyToken }, 2));
    let last = redone;
    for (let i = 0; i < 24; i++)
      last = await service.invoke("pdf_rotate_pages", doc$(doc, { indices: [0], direction: 1 }, last.revision));
    assert.equal(last.retainedHistoryTokens.length, 20);
    assert.ok(!last.retainedHistoryTokens.includes(edit.historyToken));
    await assert.rejects(service.invoke("pdf_restore_snapshot", doc$(doc, { token: edit.historyToken }, last.revision)), /expired/i);
    await service.invoke("pdf_close", { docId: doc.id });
    await assert.rejects(service.invoke("pdf_restore_snapshot", doc$(doc, { token: last.historyToken }, last.revision)), /closed|unknown/i);
  } finally {
    await service.dispose();
  }
});

test("snapshot byte budget evicts a single snapshot larger than 64MiB", async () => {
  const { service, doc } = await fixture();
  try {
    const state = (service as any).documents.get(doc.id);
    state.bytes = Buffer.concat([state.bytes, Buffer.alloc(64 * 1024 * 1024, 32)]);
    const result: any = await service.invoke("pdf_rotate_pages", doc$(doc, { indices: [0], direction: 1 }));
    assert.deepEqual(result.retainedHistoryTokens, []);
    await assert.rejects(service.invoke("pdf_restore_snapshot", doc$(doc, { token: result.historyToken }, 1)), /expired/i);
  } finally {
    await service.dispose();
  }
});

test("removed restore-transaction commands are unsupported", async () => {
  const { service, doc } = await fixture();
  try {
    for (const command of ["pdf_accept_restore", "pdf_rollback_restore", "annotations_load", "annotations_save"])
      await assert.rejects(service.invoke(command, doc$(doc)), /Unsupported/);
  } finally {
    await service.dispose();
  }
});

test("legacy sidecar loads read-only and is never written", async () => {
  const { service, doc, path, dir } = await fixture();
  try {
    await service.invoke("pdf_close", { docId: doc.id });
    const root = join(dir, "data", "annotations");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(root, { recursive: true });
    const legacy = { annotations: [rect("old")] };
    await writeFile(join(root, aliasName(path)), JSON.stringify(legacy));
    const before = (await readdir(root)).sort();
    const bytesBefore = await readFile(path);
    const reopened: any = await service.invoke("pdf_open", { path });
    assert.equal(reopened.annotations, null);
    assert.equal(reopened.legacy.annotations[0].id, "old");
    assert.match(reopened.legacy.message, /이전 버전 주석/);
    assert.deepEqual((await readdir(root)).sort(), before);
    assert.deepEqual(await readFile(path), bytesBefore);
    // Embedded annotations win over a legacy sidecar.
    await service.invoke(
      "pdf_save_document",
      doc$(reopened, { targetPath: path, annotations: sidecar(rect("new")), includeOcr: false }),
    );
    await service.invoke("pdf_close", { docId: reopened.id });
    const again: any = await service.invoke("pdf_open", { path });
    assert.equal(again.annotations[0].id, "new");
    assert.equal(again.legacy, null);
  } finally {
    await service.dispose();
  }
});

test("pdf_close and dispose survive OCR cache failures", async () => {
  const { service, doc } = await fixture();
  const state = (service as any).documents.get(doc.id);
  state.ocr.set(0, { text: "a", lines: [] });
  state.ocrDirty = true;
  (service as any).cache.save = async () => {
    throw new Error("disk full");
  };
  const log = console.error;
  console.error = () => {};
  try {
    await service.invoke("pdf_close", { docId: doc.id });
    assert.equal((service as any).documents.size, 0);
    const second: any = await service.invoke("pdf_open", { path: doc.path });
    const s2 = (service as any).documents.get(second.id);
    s2.ocr.set(0, { text: "b", lines: [] });
    s2.ocrDirty = true;
    await service.dispose();
  } finally {
    console.error = log;
  }
});

test("OCR cache is keyed by base bytes under the data directory", async () => {
  const { service, doc, dir } = await fixture();
  try {
    const state = (service as any).documents.get(doc.id);
    state.ocr.set(1, { text: "x", lines: [{ text: "x", x: 0.1, y: 0.1, w: 0.2, h: 0.1 }] });
    state.ocrDirty = true;
    await service.invoke("pdf_ocr_flush", doc$(doc));
    const files = await readdir(join(dir, "data", "ocr"));
    assert.deepEqual(files, [`${fingerprint(state.bytes)}.json`]);
  } finally {
    await service.dispose();
  }
});

test("pdf_apply_form_bytes replaces the base with an identity mapping", async () => {
  const { service, doc } = await fixture();
  try {
    const next = await pdfBytes(3);
    const result: any = await service.invoke("pdf_apply_form_bytes", doc$(doc, { bytes: next }));
    assert.deepEqual(result.pageMapping, [0, 1, 2]);
    assert.equal(typeof result.historyToken, "string");
    assert.equal(result.revision, 1);
    await assert.rejects(service.invoke("pdf_apply_form_bytes", doc$(doc, { bytes: await pdfBytes(2) }, 1)));
  } finally {
    await service.dispose();
  }
});

test("crop box and intrinsic rotation metadata use displayed dimensions", async () => {
  const { service, dir } = await fixture();
  try {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([400, 600]);
    page.setCropBox(30, 40, 200, 300);
    page.setRotation(degrees(270));
    const path = join(dir, "crop.pdf");
    await writeFile(path, await pdf.save());
    const opened: any = await service.invoke("pdf_open", { path });
    assert.deepEqual(opened.pages, [{ index: 0, width: 300, height: 200, rotation: 270 }]);
  } finally {
    await service.dispose();
  }
});
