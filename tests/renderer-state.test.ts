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
const { emptyAnnotationTabState, documentStore, setDocumentStore } =
  await import("../src/state/document");
const { addDocumentTab, buildAnnotationPayload } = await import("../src/ipc/pdf");
const { writeDraftForTab, DRAFT_DEBOUNCE_MS } =
  await import("../src/annotations/persistence");

const doc = {
  id: "d1",
  revision: 0,
  path: "/a.pdf",
  pageCount: 1,
  pages: [{ index: 0, width: 595, height: 842, rotation: 0 as const }],
  fileSize: 10,
  readOnly: false,
  readOnlyReason: null,
  signed: false,
};
const text = {
  id: "t1",
  page: 0,
  type: "text" as const,
  rect: { x: 10, y: 10, w: 220, h: 56 },
  style: { color: "#000000", width: 1, fontSize: 16 },
  payload: { text: "안녕" },
};

test("annotation state has a monotonic save version", () => {
  assert.equal(emptyAnnotationTabState().editVersion, 0);
});

test("a new tab starts clean with the document's flags", () => {
  const id = addDocumentTab({ ...doc, signed: true });
  const tab = documentStore.tabs.find((t) => t.tabId === id)!;
  assert.equal(tab.signed, true);
  assert.equal(tab.formDirty, false);
  assert.equal(tab.annotations.dirty, false);
  assert.equal(tab.pageDirty, false);
  assert.equal(documentStore.activeTabId, id);
  setDocumentStore({ tabs: [], activeTabId: null });
});

test("the annotation payload is a plain v2 sidecar of the tab's items", async () => {
  const id = addDocumentTab(doc, { annotations: [text] });
  const tab = documentStore.tabs.find((t) => t.tabId === id)!;
  const payload = await buildAnnotationPayload(tab);
  assert.equal(payload.version, 2);
  assert.equal(payload.sourcePath, "/a.pdf");
  assert.equal(payload.annotations.length, 1);
  assert.equal(payload.annotations[0].id, "t1");
  assert.equal(JSON.stringify(payload), JSON.stringify(JSON.parse(JSON.stringify(payload))));
  setDocumentStore({ tabs: [], activeTabId: null });
});

test("draft writes are limited to dirty tabs with real paths", async () => {
  const writes: Array<{ path: string; json: string }> = [];
  setDesktopForTests({
    invoke: async (cmd: string, args: any) => {
      if (cmd === "draft_write") writes.push(args);
    },
  } as any);
  try {
    assert.equal(DRAFT_DEBOUNCE_MS, 1000);
    const clean = addDocumentTab(doc, { annotations: [text] });
    await writeDraftForTab(clean);
    assert.equal(writes.length, 0);
    const dirty = addDocumentTab({ ...doc, id: "d2", path: "/b.pdf" }, { annotations: [text], dirty: true });
    await writeDraftForTab(dirty);
    assert.equal(writes.length, 1);
    assert.equal(writes[0].path, "/b.pdf");
    const draft = JSON.parse(writes[0].json);
    assert.equal(draft.annotations[0].id, "t1");
    assert.ok(draft.savedAt);
    const unsaved = addDocumentTab({ ...doc, id: "d3", path: "unsaved://x.pdf" }, { unsaved: true, annotations: [text], dirty: true });
    await writeDraftForTab(unsaved);
    assert.equal(writes.length, 1);
  } finally {
    setDesktopForTests(null);
    setDocumentStore({ tabs: [], activeTabId: null });
  }
});
