import test from "node:test";
import assert from "node:assert/strict";
import { MAX_PRINT_PAGES, PRINT_DPI, runPrint, type PrintDeps } from "../src/print/print";

const tab: any = { tabId: "t", docId: "d", revision: 3, path: "/a/b.pdf", readOnly: false };

function makeDeps(over: Partial<PrintDeps> & { pages?: number } = {}) {
  const calls: any = { invoke: [], toasts: [], scales: [], destroyed: 0 };
  const pageCount = over.pages ?? 2;
  const doc: any = {
    numPages: pageCount,
    loadingTask: { destroy: async () => { calls.destroyed++; } },
  };
  const deps: PrintDeps = {
    invoke: (async (cmd: string, args: any) => {
      calls.invoke.push([cmd, args]);
      return cmd === "print_images" ? true : new Uint8Array([1]);
    }) as any,
    toast: (m, k) => calls.toasts.push([m, k]),
    buildPayload: async () => ({ annotations: [] }) as any,
    openBytes: async () => doc,
    getDocument: async () => doc,
    renderPage: async (_d, i, dpi) => {
      calls.scales.push(dpi);
      return { png: new Uint8Array([i]), widthPt: 612, heightPt: 792 };
    },
    fileName: (p) => p.split("/").pop()!,
    ...over,
  };
  return { deps, calls, doc };
}

test("read-only path never flattens", async () => {
  const { deps, calls } = makeDeps();
  await runPrint({ ...tab, readOnly: true }, deps);
  assert.ok(!calls.invoke.some((c: any) => c[0] === "pdf_flatten_bytes"));
  const p = calls.invoke.find((c: any) => c[0] === "print_images");
  assert.equal(p[1].pages.length, 2);
  assert.equal(p[1].title, "b.pdf");
});

test("editable path flattens, renders at 150 dpi, destroys", async () => {
  const { deps, calls } = makeDeps();
  await runPrint(tab, deps);
  const f = calls.invoke[0];
  assert.equal(f[0], "pdf_flatten_bytes");
  assert.deepEqual(f[1].docId, "d");
  assert.equal(f[1].expectedRevision, 3);
  assert.equal(f[1].includeOcr, false);
  assert.deepEqual(calls.scales, [PRINT_DPI, PRINT_DPI]);
  assert.equal(PRINT_DPI, 150);
  assert.equal(calls.destroyed, 1);
});

test("page cap refuses with toast", async () => {
  const { deps, calls } = makeDeps({ pages: MAX_PRINT_PAGES + 1 });
  await runPrint({ ...tab, readOnly: true }, deps);
  assert.ok(!calls.invoke.some((c: any) => c[0] === "print_images"));
  assert.equal(calls.toasts.at(-1)[1], "error");
});

test("cancel and error toasts", async () => {
  const a = makeDeps();
  const inv = a.deps.invoke;
  a.deps.invoke = (async (c: string, g: any) => (c === "print_images" ? false : inv(c, g))) as any;
  await runPrint(tab, a.deps);
  assert.deepEqual(a.calls.toasts.at(-1), ["인쇄를 취소했습니다", "info"]);
  const b = makeDeps({ renderPage: async () => { throw new Error("boom"); } });
  await runPrint(tab, b.deps);
  assert.deepEqual(b.calls.toasts.at(-1), ["인쇄 실패: boom", "error"]);
});

test("progress toast every 5 pages", async () => {
  const { deps, calls } = makeDeps({ pages: 10 });
  await runPrint({ ...tab, readOnly: true }, deps);
  const prog = calls.toasts.filter((t: any) => t[0].startsWith("인쇄 준비 중"));
  assert.ok(prog.length >= 2 && prog.length <= 4);
});
