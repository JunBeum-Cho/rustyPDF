import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  writeFile,
  readFile,
  rename,
  copyFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PDFDocument } from "pdf-lib";
import { PdfService } from "../electron/pdf-service";
async function fixture(count = 3) {
  const dir = await mkdtemp(join(tmpdir(), "rustypdf-service-"));
  const path = join(dir, "input.pdf");
  const pdf = await PDFDocument.create();
  for (let i = 0; i < count; i++) pdf.addPage([200 + i * 10, 300]);
  await writeFile(path, await pdf.save());
  const service = new PdfService({ dataDir: join(dir, "data") });
  const doc: any = await service.invoke("pdf_open", { path });
  return { dir, path, service, doc };
}
test("stale revision rejected; rotations and page mapping persist", async () => {
  const { service, doc } = await fixture();
  try {
    const rotated: any = await service.invoke("pdf_rotate_pages", {
      docId: doc.id,
      expectedRevision: 0,
      indices: [0],
      direction: 1,
    });
    assert.deepEqual(rotated.pages[0], {
      index: 0,
      width: 300,
      height: 200,
      rotation: 90,
    });
    await assert.rejects(
      service.invoke("pdf_document_bytes", {
        docId: doc.id,
        expectedRevision: 0,
      }),
      /revision|stale/i,
    );
    const deleted: any = await service.invoke("pdf_delete_pages", {
      docId: doc.id,
      expectedRevision: 1,
      indices: [1],
    });
    assert.deepEqual(deleted.pageMapping, [0, null, 1]);
    await assert.rejects(
      service.invoke("pdf_delete_pages", {
        docId: doc.id,
        expectedRevision: 2,
        indices: [0, 1],
      }),
    );
  } finally {
    await service.dispose();
  }
});
test("external modification rejects save and annotation autosave", async () => {
  const { service, doc, path } = await fixture();
  try {
    await writeFile(path, "external edit");
    await assert.rejects(
      service.invoke("pdf_save_document", {
        docId: doc.id,
        expectedRevision: 0,
        targetPath: path,
      }),
      /external/i,
    );
    await assert.rejects(
      service.invoke("annotations_save", {
        docId: doc.id,
        expectedRevision: 0,
        path,
        data: { annotations: [] },
      }),
      /external/i,
    );
    assert.equal(await readFile(path, "utf8"), "external edit");
  } finally {
    await service.dispose();
  }
});
test("identical copies independent; unique move recovers and durably claims", async () => {
  const { service, doc, path, dir } = await fixture();
  try {
    await service.invoke("annotations_save", {
      docId: doc.id,
      expectedRevision: 0,
      path,
      data: { version: 2, documentKey: "owner", annotations: [{ id: "note" }] },
    });
    const copy = join(dir, "copy.pdf");
    await copyFile(path, copy);
    const c: any = await service.invoke("pdf_open", { path: copy });
    assert.equal(
      (
        (await service.invoke("annotations_load", {
          docId: c.id,
          expectedRevision: 0,
          path: copy,
        })) as any
      ).status,
      "ambiguous",
    );
    const moved = join(dir, "moved.pdf");
    await rename(path, moved);
    const m: any = await service.invoke("pdf_open", { path: moved });
    assert.equal(
      (
        (await service.invoke("annotations_load", {
          docId: m.id,
          expectedRevision: 0,
          path: moved,
        })) as any
      ).status,
      "recovered",
    );
    assert.equal(
      (
        (await service.invoke("annotations_load", {
          docId: c.id,
          expectedRevision: 0,
          path: copy,
        })) as any
      ).sidecar,
      null,
    );
  } finally {
    await service.dispose();
  }
});
test("single clipboard survives source close and old token expires", async () => {
  const { service, doc, path, dir } = await fixture();
  try {
    const token = await service.invoke("pdf_copy_pages", {
      docId: doc.id,
      expectedRevision: 0,
      indices: [2, 0],
    });
    const latest = await service.invoke("pdf_copy_pages", {
      docId: doc.id,
      expectedRevision: 0,
      indices: [1],
    });
    await service.invoke("pdf_close", { docId: doc.id });
    const copy = join(dir, "target.pdf");
    await copyFile(path, copy);
    const target: any = await service.invoke("pdf_open", { path: copy });
    await assert.rejects(
      service.invoke("pdf_paste_pages", {
        docId: target.id,
        expectedRevision: 0,
        afterIndex: 0,
        clipboardId: token,
      }),
    );
    const pasted: any = await service.invoke("pdf_paste_pages", {
      docId: target.id,
      expectedRevision: 0,
      afterIndex: 0,
      clipboardId: latest,
    });
    assert.equal(pasted.pageCount, 4);
    assert.deepEqual(pasted.pageMapping, [0, 2, 3]);
  } finally {
    await service.dispose();
  }
});
test("image PDF preserves order and A4 page orientation", async () => {
  const { service, dir } = await fixture();
  try {
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAGQAAAAyCAIAAAAlV+npAAAAgUlEQVR4nO3QQQ0AIAzAwPk3DRbWFyG5U9B0DmvzOuAnZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFZgVmBWYFF2jSYM8m2Qt/AAAAAElFTkSuQmCC",
      "base64",
    );
    const first = join(dir, "first.png"),
      second = join(dir, "second.png");
    await writeFile(first, png);
    await writeFile(second, png);
    const opened: any = await service.invoke("pdf_create_from_images", {
      paths: [first, second],
      name: "테스트.pdf",
    });
    assert.equal(opened.pageCount, 2);
    assert.match(opened.path, /unsaved:\/\/.*테스트\.pdf/);
    assert.ok(Math.abs(opened.pages[0].width - 841.8898) < 0.01);
    const bytes = await service.invoke("pdf_document_bytes", {
      docId: opened.id,
      expectedRevision: 0,
    });
    assert.equal((await PDFDocument.load(bytes)).getPageCount(), 2);
  } finally {
    await service.dispose();
  }
});
test("normal save preserves editable annotations and revision bytes", async () => {
  const { service, doc, path } = await fixture();
  try {
    await service.invoke("pdf_save_document", {
      docId: doc.id,
      expectedRevision: 0,
      targetPath: path,
      sidecar: {
        version: 2,
        documentKey: "editable",
        annotations: [{ id: "note" }],
      },
    });
    const loaded: any = await service.invoke("annotations_load", {
      docId: doc.id,
      expectedRevision: 1,
      path,
    });
    assert.equal(loaded.status, "exact");
    assert.equal(loaded.sidecar.annotations[0].id, "note");
    assert.deepEqual(
      await readFile(path),
      Buffer.from(
        await service.invoke("pdf_document_bytes", {
          docId: doc.id,
          expectedRevision: 1,
        }),
      ),
    );
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
    const { degrees } = await import("pdf-lib");
    page.setRotation(degrees(270));
    const path = join(dir, "crop.pdf");
    await writeFile(path, await pdf.save());
    const opened: any = await service.invoke("pdf_open", { path });
    assert.deepEqual(opened.pages, [
      { index: 0, width: 300, height: 200, rotation: 270 },
    ]);
  } finally {
    await service.dispose();
  }
});

test("page history restores bytes, rejects stale restore and bounds retained snapshots", async () => {
  const { service, doc } = await fixture();
  try {
    const original = await service.invoke("pdf_document_bytes", {docId: doc.id, expectedRevision: 0});
    const edit = await service.invoke("pdf_delete_pages", {docId: doc.id, expectedRevision: 0, indices: [1]});
    assert.equal(typeof edit.historyToken, "string");
    await assert.rejects(service.invoke("pdf_restore_snapshot", {docId: doc.id, expectedRevision: 0, token: edit.historyToken}), /revision/i);
    const restored = await service.invoke("pdf_restore_snapshot", {docId: doc.id, expectedRevision: 1, token: edit.historyToken});
    assert.equal(restored.pageCount, 3);
    assert.deepEqual(await service.invoke("pdf_document_bytes", {docId: doc.id, expectedRevision: 2}), original);
    const redone = await service.invoke("pdf_restore_snapshot", {docId: doc.id, expectedRevision: 2, token: edit.historyToken});
    assert.equal(redone.pageCount, 2);
    let last = redone;
    for(let i=0;i<24;i++) last = await service.invoke("pdf_rotate_pages", {docId: doc.id, expectedRevision: last.revision, indices:[0], direction:1});
    assert.equal(last.retainedHistoryTokens.length, 20);
    assert.ok(!last.retainedHistoryTokens.includes(edit.historyToken));
    await assert.rejects(service.invoke("pdf_restore_snapshot", {docId:doc.id,expectedRevision:last.revision,token:edit.historyToken}), /expired/i);
    await service.invoke("pdf_close", {docId:doc.id});
    await assert.rejects(service.invoke("pdf_restore_snapshot", {docId:doc.id,expectedRevision:last.revision,token:last.historyToken}), /closed|unknown/i);
  } finally { await service.dispose(); }
});

test("snapshot byte budget evicts a single document larger than 64MiB", async () => {
  const {service,doc} = await fixture();
  try {
    // Pad a valid PDF with whitespace: the committed page data stays tiny,
    // while the original byte snapshot exceeds the retention budget.
    const state = (service as any).documents.get(doc.id);
    state.bytes = Buffer.concat([state.bytes, Buffer.alloc(64 * 1024 * 1024, 32)]);
    const result = await service.invoke("pdf_rotate_pages",{docId:doc.id,expectedRevision:0,indices:[0],direction:1});
    assert.deepEqual(result.retainedHistoryTokens,[]);
    assert.equal(state.history.size,0);
    await assert.rejects(service.invoke("pdf_restore_snapshot",{docId:doc.id,expectedRevision:1,token:result.historyToken}),/expired/i);
  } finally {await service.dispose();}
});

test("transactional rollback survives history eviction of an oversized current snapshot", async () => {
 const {service,doc} = await fixture();
 try {
  const edit=await service.invoke("pdf_delete_pages",{docId:doc.id,expectedRevision:0,indices:[1]});
  const state=(service as any).documents.get(doc.id);
  state.bytes=Buffer.concat([state.bytes,Buffer.alloc(64*1024*1024,32)]);
  const previous=state.bytes;
  const restore=await service.invoke("pdf_restore_snapshot",{docId:doc.id,expectedRevision:1,token:edit.historyToken,transactional:true});
  assert.deepEqual(restore.retainedHistoryTokens,[]);
  assert.equal(typeof restore.restoreTransaction,"string");
  await assert.rejects(service.invoke("pdf_rotate_pages",{docId:doc.id,expectedRevision:2,indices:[0],direction:1}),/pending/);
  await assert.rejects(service.invoke("pdf_restore_snapshot",{docId:doc.id,expectedRevision:2,token:edit.historyToken,transactional:true}),/pending/);
  const rollback=await service.invoke("pdf_rollback_restore",{docId:doc.id,expectedRevision:2,restoreTransaction:restore.restoreTransaction});
  assert.equal(rollback.pageCount,2);
  assert.equal(state.bytes,previous);
  assert.equal(state.pendingRestore,undefined);
  assert.ok(rollback.retainedHistoryTokens.includes(edit.historyToken));
 } finally {await service.dispose();}
});

test("export snapshots completed OCR before awaits and preserves editable source state", async () => {
  const {service, doc, path, dir} = await fixture();
  const state = (service as any).documents.get(doc.id);
  const first = { text: "Completed OCR", lines: [{text:"Completed OCR", x:0.1,y:0.1,w:0.7,h:0.1}] };
  state.ocr.set(0,first); state.ocrDirty = true;
  const original = state.bytes.slice(), disk = await readFile(path);
  const originalConflict = (service as any).conflict.bind(service);
  // Simulate asynchronous work at the export boundary. Later cache changes must
  // not leak into the already selected export snapshot, even in existing lines.
  (service as any).conflict = async (...args: any[]) => {
    await originalConflict(...args);
    first.lines[0].text = "Changed later";
    state.ocr.set(1, {text:"Late OCR",lines:[{text:"Late OCR",x:0.1,y:0.2,w:0.5,h:0.1}]});
  };
  try {
    const targetPath = join(dir,"searchable.pdf");
    await service.invoke("export_annotated_pdf", {docId:doc.id, expectedRevision:0,targetPath,data:{annotations:[]}});
    const canvas = await import("@napi-rs/canvas");
    for (const key of ["DOMMatrix","ImageData","Path2D"] as const) (globalThis as any)[key] = canvas[key];
    const {getDocument} = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const task = getDocument({data:new Uint8Array(await readFile(targetPath))});
    const pdf = await task.promise;
    try {
      const text = (await (await pdf.getPage(1)).getTextContent()).items.map((i:any)=>i.str ?? "").join("");
      assert.equal(text,"Completed OCR");
      assert.equal((await (await pdf.getPage(2)).getTextContent()).items.length,0);
    } finally {await task.destroy();}
    assert.equal(state.path,path); assert.equal(state.revision,0); assert.equal(state.ocrDirty,true);
    assert.deepEqual(state.bytes,original); assert.deepEqual(await readFile(path),disk);
    await assert.rejects(readFile(`${targetPath}.ocr.json`), /ENOENT/);
    // Existing revision guard still applies to export.
    await assert.rejects(service.invoke("export_annotated_pdf",{docId:doc.id,expectedRevision:1,targetPath,data:{annotations:[]}}),/revision/i);
  } finally {await service.dispose();}
});
