import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
import { JSDOM } from "jsdom";
import { setDesktopForTests } from "../src/platform/desktop";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document });
register(
  `data:text/javascript,${encodeURIComponent('export async function load(url, context, nextLoad) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context); }')}`,
  import.meta.url,
);
const pdf = await import("../src/ipc/pdf");
const { documentStore, setDocumentStore } = await import("../src/state/document");
const { setToastEmitter } = await import("../src/capture/capture");

const base = {
  id: "doc-1",
  revision: 0,
  path: "/a.pdf",
  pageCount: 1,
  pages: [{ index: 0, width: 595, height: 842, rotation: 0 as const }],
  fileSize: 10,
  readOnly: false,
  readOnlyReason: null,
  signed: false,
  annotations: null,
  legacy: null,
};
const note = (id: string) => ({
  id,
  page: 0,
  type: "rect" as const,
  rect: { x: 1, y: 1, w: 20, h: 20 },
  style: { color: "#ff0000", width: 2 },
});

type Handler = (cmd: string, args: any) => any;
function setup(handler: Handler, extra: Record<string, unknown> = {}) {
  const toasts: any[] = [];
  const listeners = new Map<string, (payload: unknown) => void>();
  setToastEmitter((t) => toasts.push(t));
  setDesktopForTests({
    invoke: async (cmd: string, args: any) => handler(cmd, args),
    ask: async () => true,
    listen: async (name: string, fn: (p: unknown) => void) => {
      listeners.set(name, fn);
      return () => listeners.delete(name);
    },
    ...extra,
  } as any);
  return { toasts, listeners };
}
const reset = () => {
  setDesktopForTests(null);
  setToastEmitter(null);
  setDocumentStore({ tabs: [], activeTabId: null });
};

test("the same file through two paths gives one tab", async () => {
  setup((cmd) => {
    if (cmd === "pdf_open") return base;
    if (cmd === "draft_read") return null;
    throw new Error(cmd);
  });
  try {
    await pdf.openPdf("/a.pdf");
    await pdf.openPdf("/link/to/a.pdf");
    assert.equal(documentStore.tabs.length, 1);
  } finally {
    reset();
  }
});

test("legacy annotations open dirty with a notice", async () => {
  const { toasts } = setup((cmd) => {
    if (cmd === "pdf_open")
      return { ...base, legacy: { annotations: [note("old")], message: "x" } };
    if (cmd === "draft_read") return null;
    throw new Error(cmd);
  });
  try {
    await pdf.openPdf("/a.pdf");
    const tab = documentStore.tabs[0];
    assert.equal(tab.annotations.items[0].id, "old");
    assert.equal(tab.annotations.dirty, true);
    assert.ok(toasts.some((t) => t.message.includes("이전 버전 주석을 불러왔습니다")));
  } finally {
    reset();
  }
});

test("a differing draft is offered and restoring marks the tab dirty", async () => {
  const { toasts } = setup((cmd) => {
    if (cmd === "pdf_open") return { ...base, annotations: [note("a")] };
    if (cmd === "draft_read")
      return JSON.stringify({ savedAt: "2026-10-23T00:00:00Z", annotations: [note("a"), note("b")] });
    throw new Error(cmd);
  });
  try {
    await pdf.openPdf("/a.pdf");
    const tab = documentStore.tabs[0];
    assert.equal(tab.annotations.items.length, 1);
    assert.equal(tab.annotations.dirty, false);
    const toast = toasts.find((t) => t.actions?.[0]?.label === "복구");
    assert.ok(toast);
    assert.equal(toast.timeoutMs, null);
    toast.actions[0].run();
    assert.equal(documentStore.tabs[0].annotations.items.length, 2);
    assert.equal(documentStore.tabs[0].annotations.dirty, true);
  } finally {
    reset();
  }
});

test("an identical draft is not offered", async () => {
  const { toasts } = setup((cmd) => {
    if (cmd === "pdf_open") return { ...base, annotations: [note("a")] };
    if (cmd === "draft_read") return JSON.stringify({ savedAt: "x", annotations: [note("a")] });
    throw new Error(cmd);
  });
  try {
    await pdf.openPdf("/a.pdf");
    assert.equal(toasts.length, 0);
  } finally {
    reset();
  }
});

test("service restart reopens real-path tabs and keeps annotations", async () => {
  const opens: string[] = [];
  const { listeners, toasts } = setup((cmd, args) => {
    if (cmd === "pdf_open") {
      opens.push(args.path);
      return { ...base, id: opens.length === 1 ? "doc-1" : "doc-2", annotations: null };
    }
    if (cmd === "draft_read") return null;
    throw new Error(cmd);
  });
  const detach = pdf.attachDocumentEventHandlers();
  try {
    await pdf.openPdf("/a.pdf");
    setDocumentStore("tabs", 0, "annotations", "items", [note("keep") as any]);
    setDocumentStore("tabs", 0, "pageDirty", true);
    await Promise.resolve();
    listeners.get("pdf-service-restarted")!(null);
    for (let i = 0; i < 20 && opens.length < 2; i++) await new Promise((r) => setTimeout(r, 5));
    for (let i = 0; i < 20 && toasts.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    assert.deepEqual(opens, ["/a.pdf", "/a.pdf"]);
    const tab = documentStore.tabs[0];
    assert.equal(tab.docId, "doc-2");
    assert.equal(tab.annotations.items[0].id, "keep");
    assert.equal(tab.pageDirty, false);
    assert.ok(toasts.some((t) => t.message.includes("PDF 엔진이 다시 시작되어")));
  } finally {
    detach();
    reset();
  }
});

test("read-only tabs refuse to save", async () => {
  const commands: string[] = [];
  const { toasts } = setup((cmd) => {
    commands.push(cmd);
    if (cmd === "pdf_open") return { ...base, readOnly: true, readOnlyReason: "encrypted" };
    if (cmd === "draft_read") return null;
    throw new Error(cmd);
  });
  try {
    await pdf.openPdf("/a.pdf");
    assert.equal(await pdf.saveActivePdf(), false);
    assert.ok(toasts.some((t) => t.message === "읽기 전용 PDF는 저장할 수 없습니다"));
    assert.equal(commands.includes("pdf_save_document"), false);
  } finally {
    reset();
  }
});

test("save sends the annotations, clears dirty flags and deletes the draft", async () => {
  let saveArgs: any;
  const commands: string[] = [];
  setup((cmd, args) => {
    commands.push(cmd);
    if (cmd === "pdf_open") return { ...base, annotations: [note("a")] };
    if (cmd === "draft_read") return null;
    if (cmd === "pdf_save_document") {
      saveArgs = args;
      return { ...base, revision: 1 };
    }
    if (cmd === "draft_delete") return;
    throw new Error(cmd);
  });
  try {
    await pdf.openPdf("/a.pdf");
    setDocumentStore("tabs", 0, "annotations", "dirty", true);
    setDocumentStore("tabs", 0, "formDirty", true);
    assert.equal(await pdf.saveActivePdf(), true);
    assert.equal(saveArgs.targetPath, "/a.pdf");
    assert.equal(saveArgs.expectedRevision, 0);
    assert.equal(saveArgs.annotations.annotations[0].id, "a");
    assert.equal(typeof saveArgs.includeOcr, "boolean");
    const tab = documentStore.tabs[0];
    assert.equal(tab.annotations.dirty, false);
    assert.equal(tab.formDirty, false);
    assert.equal(tab.revision, 1);
    assert.ok(commands.includes("draft_delete"));
  } finally {
    reset();
  }
});

test("a signed document asks once before saving", async () => {
  let asks = 0;
  setup(
    (cmd) => {
      if (cmd === "pdf_open") return { ...base, signed: true };
      if (cmd === "draft_read") return null;
      if (cmd === "pdf_save_document") return { ...base, signed: true, revision: 1 };
      if (cmd === "draft_delete") return;
      throw new Error(cmd);
    },
    { ask: async () => (asks++, true) },
  );
  try {
    await pdf.openPdf("/a.pdf");
    await pdf.saveActivePdf();
    await pdf.saveActivePdf();
    assert.equal(asks, 1);
  } finally {
    reset();
  }
});

test("openPdf resolves false after exactly one failure toast", async () => {
  const { toasts } = setup((cmd) => {
    if (cmd === "pdf_open") throw new Error("깨진 PDF");
    throw new Error(cmd);
  });
  try {
    assert.equal(await pdf.openPdf("/bad.pdf"), false);
    assert.equal(toasts.filter((t) => t.kind === "error" || t.type === "error").length, 1);
    assert.equal(toasts.length, 1);
  } finally {
    reset();
  }
});
