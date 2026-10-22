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

test("renderer raster uses96dpi and small capture preserves600dpi without fullpage allocation", async () => {
  const { PdfEngine } = await import("../src/platform/pdf-engine");
  const previous = globalThis.document;
  const allocated: { width: number; height: number }[] = [];
  let renderOptions: any;
  const page = {
    rotate: 0,
    getViewport: ({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
    }),
    render: (options: any) => {
      renderOptions = options;
      return { promise: Promise.resolve() };
    },
  };
  const canvases: any[] = [];
  (globalThis as any).document = {
    createElement: () => {
      const canvas: any = {
        width: 0,
        height: 0,
        getContext: () => ({
          getImageData: () => ({
            data: new Uint8ClampedArray(canvas.width * canvas.height * 4),
          }),
        }),
        toBlob: (callback: any) => {
          allocated.push({ width: canvas.width, height: canvas.height });
          callback(new Blob(["png"]));
        },
      };
      canvases.push(canvas);
      return canvas;
    },
  };
  const engine = new PdfEngine(async () => {
    throw new Error("Unexpected host command");
  });
  (engine as any).page = async () => page;
  try {
    const rendered = (await engine.invoke("pdf_render_page", {
      docId: "fixture",
      expectedRevision: 0,
      pageIndex: 0,
      scale: 1,
    })) as ArrayBuffer;
    assert.equal(new DataView(rendered).getUint32(0), 816);
    assert.equal(new DataView(rendered).getUint32(4), 1056);
    await engine.invoke("pdf_capture_region", {
      docId: "fixture",
      expectedRevision: 0,
      pageIndex: 0,
      scale: 600 / 96,
      x: 0.2,
      y: 0.3,
      w: 0.1,
      h: 0.1,
    });
    assert.deepEqual(allocated, [{ width: 510, height: 660 }]);
    assert.equal(renderOptions.viewport.width, 5100);
    assert.deepEqual(renderOptions.transform.slice(0, 5), [1, 0, 0, 1, -1020]);
    assert.ok(Math.abs(renderOptions.transform[5] + 1980) < 1e-8);
    assert.ok(
      canvases.every((canvas) => canvas.width === 0 && canvas.height === 0),
    );
  } finally {
    (globalThis as any).document = previous;
    engine.dispose();
  }
});

test("search includes OCR text alongside native text with Unicode scalar offsets", async () => {
  const { PdfEngine } = await import("../src/platform/pdf-engine");
  const engine = new PdfEngine(async (command) => {
    assert.equal(command, "pdf_ocr_lines");
    return [{ text: "😀 OCR 한국어", x: 0, y: 0, w: 1, h: 1 }];
  });
  (engine as any).document = async () => ({
    numPages: 1,
    getPage: async () => ({}),
  });
  (engine as any).lines = async () => [
    { text: "native", x: 0, y: 0, w: 1, h: 1 },
  ];
  assert.deepEqual(
    await engine.invoke("pdf_search", {
      docId: "fixture",
      expectedRevision: 0,
      query: "한국어",
    }),
    [{ page: 0, start: 13, length: 3, snippet: "native\n😀 OCR 한국어", space: "display", rectangles: [{ x: 6/9, y: 0, w: 3/9, h: 1 }] }],
  );
  engine.dispose();
});
