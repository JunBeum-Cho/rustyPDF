import { test } from "node:test";
import assert from "node:assert/strict";
import { RevisionCache, boundedViewport } from "../src/platform/pdf-engine";
test("revision cache deduplicates bytes and rejects superseded requests", async () => {
  const cache = new RevisionCache<number>();
  let resolve!: (n: number) => void;
  const old = cache.get(
    "d",
    0,
    () => new Promise<number>((r) => (resolve = r)),
  );
  const fresh = cache.get("d", 1, async () => 2);
  resolve(1);
  await assert.rejects(old, /stale/);
  assert.equal(await fresh, 2);
  assert.equal(await cache.get("d", 1, async () => 3), 2);
});
test("closed document rejects pending render and bounded viewport limits allocation", async () => {
  const cache = new RevisionCache<number>();
  let resolve!: (n: number) => void;
  const request = cache.get(
    "d",
    0,
    () => new Promise<number>((r) => (resolve = r)),
  );
  cache.close("d");
  resolve(1);
  await assert.rejects(request, /stale/);
  const size = boundedViewport(100000, 100000);
  assert.ok(size.width * size.height <= 16_000_000);
  assert.throws(() => boundedViewport(Infinity, 1));
});


function fixture() {
  const calls: any = { render: [], cancels: 0, allocated: [] as any[], canvases: [] as any[], host: [] as any[] };
  const page = {
    rotate: 0,
    getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
    getTextContent: async () => ({ items: [{ str: "  " }, { str: "PDF" }] }),
    render: (options: any) => {
      calls.render.push(options);
      return { promise: Promise.resolve(), cancel: () => calls.cancels++ };
    },
  };
  const mk = () => {
    const canvas: any = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage() {} }),
      toBlob: (cb: any) => {
        calls.allocated.push({ width: canvas.width, height: canvas.height });
        cb(new Blob(["png"]));
      },
    };
    calls.canvases.push(canvas);
    return canvas;
  };
  (globalThis as any).document = { createElement: mk };
  return { calls, page, mk };
}

async function engineWith(page: any, host: any = async () => { throw new Error("host"); }) {
  const { PdfEngine } = await import("../src/platform/pdf-engine");
  const engine = new PdfEngine(host);
  (engine as any).getDocument = async () => ({ numPages: 1, getPage: async () => page });
  return engine;
}

test("renderPage draws into the canvas at css size times dpr and cancels", async () => {
  const previous = globalThis.document;
  const { calls, page, mk } = fixture();
  const engine = await engineWith(page);
  try {
    const canvas = mk();
    const one = engine.renderPage(canvas, { docId: "d", revision: 0, pageIndex: 0, cssWidth: 612, cssHeight: 792, dpr: 1 });
    await one.promise;
    assert.deepEqual([canvas.width, canvas.height], [612, 792]);
    assert.equal(calls.render[0].canvas, canvas);
    assert.equal(calls.render[0].annotationMode, 2);
    const two = engine.renderPage(canvas, { docId: "d", revision: 0, pageIndex: 0, cssWidth: 612, cssHeight: 792, dpr: 2 });
    await two.promise;
    assert.deepEqual([canvas.width, canvas.height], [1224, 1584]);
    assert.equal(calls.render[1].viewport.width, 1224);
    const stale = engine.renderPage(canvas, { docId: "d", revision: 0, pageIndex: 0, cssWidth: 612, cssHeight: 792, dpr: 2 });
    await stale.promise;
    stale.cancel();
    assert.equal(calls.cancels, 1);
    const early = engine.renderPage(canvas, { docId: "d", revision: 0, pageIndex: 0, cssWidth: 100, cssHeight: 100, dpr: 1 });
    early.cancel();
    await early.promise;
    assert.equal(calls.render.length, 3);
  } finally {
    (globalThis as any).document = previous;
  }
});

test("renderPage bounds pixels to 16M", async () => {
  const previous = globalThis.document;
  const { page, mk } = fixture();
  const engine = await engineWith(page);
  try {
    const canvas = mk();
    await engine.renderPage(canvas, { docId: "d", revision: 0, pageIndex: 0, cssWidth: 6120, cssHeight: 7920, dpr: 2 }).promise;
    assert.ok(canvas.width * canvas.height <= 16_000_000);
  } finally {
    (globalThis as any).document = previous;
  }
});

test("capture keeps 600dpi on a small region and rejects bad regions", async () => {
  const previous = globalThis.document;
  const { calls, page } = fixture();
  const engine = await engineWith(page);
  try {
    await engine.capture("d", 0, { pageIndex: 0, x: 0.2, y: 0.3, w: 0.1, h: 0.1 });
    assert.deepEqual(calls.allocated, [{ width: 510, height: 660 }]);
    const options = calls.render[0];
    assert.equal(options.viewport.width, 5100);
    assert.deepEqual(options.transform.slice(0, 5), [1, 0, 0, 1, -1020]);
    assert.ok(Math.abs(options.transform[5] + 1980) < 1e-8);
    assert.ok(calls.canvases.every((c: any) => c.width === 0 && c.height === 0));
    await assert.rejects(engine.capture("d", 0, { pageIndex: 0, x: 0.5, y: 0, w: 0.6, h: 0.1 }), /Invalid capture/);
  } finally {
    (globalThis as any).document = previous;
  }
});

test("recognizePage renders at scale 2 and forwards the PNG to the host", async () => {
  const previous = globalThis.document;
  const { page } = fixture();
  const seen: any[] = [];
  const payload = { text: "PDF", lines: [{ text: "PDF", x: 0.1, y: 0.1, w: 0.2, h: 0.05 }] };
  const engine = await engineWith(page, async (command: string, args: any) => {
    seen.push({ command, args });
    return payload;
  });
  try {
    assert.deepEqual(await engine.recognizePage("a", 3, 0), payload);
    assert.equal(seen[0].command, "pdf_ocr_page");
    const a = seen[0].args;
    assert.equal(a.docId, "a");
    assert.equal(a.expectedRevision, 3);
    assert.equal(a.pageIndex, 0);
    assert.equal(a.imageWidth, 1632);
    assert.equal(a.imageHeight, 2112);
    assert.ok(a.image instanceof Uint8Array);
    assert.equal(await engine.pageHasText("a", 3, 0), true);
  } finally {
    (globalThis as any).document = previous;
  }
});
