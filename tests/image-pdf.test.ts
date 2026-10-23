import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
import { JSDOM } from "jsdom";
import { setDesktopForTests } from "../src/platform/desktop";
const mockIPC = (handler: (command: string, args: any) => any) =>
  setDesktopForTests({
    invoke: handler,
    save: (options: unknown) => handler("plugin:dialog|save", { options }),
    ask: async () => true,
  } as any);
const clearMocks = () => setDesktopForTests(null);

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  NodeFilter: dom.window.NodeFilter,
});
// IPC tests do not render; leave the viewer's stylesheet to Vite in the app.
register(
  `data:text/javascript,${encodeURIComponent('export async function load(url, context, nextLoad) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context); }')}`,
  import.meta.url,
);
const { openImagesAsPdf, saveActivePdf, exportAnnotatedPdfFile } =
  await import("../src/ipc/pdf");
const { activeTab, setDocumentStore } = await import("../src/state/document");

const payload = {
  id: "image-document",
  revision: 0,
  path: "unsaved://unique/사진 모음.pdf",
  pageCount: 2,
  pages: [0, 1].map((index) => ({
    index,
    width: 595,
    height: 842,
    rotation: 0,
  })),
  fileSize: 1000,
  readOnly: false,
  readOnlyReason: null,
  signed: false,
};

test("image document stays editable and unsaved until a destination is chosen", async () => {
  const commands: string[] = [];
  let cancelSave = true;
  mockIPC((cmd, args: any) => {
    commands.push(cmd);
    if (cmd === "pdf_create_from_images") {
      assert.deepEqual(args.paths, ["/tmp/first.png", "/tmp/second.jpg"]);
      return payload;
    }
    if (cmd === "plugin:dialog|save") {
      assert.equal(args.options.defaultPath, "사진 모음.pdf");
      return cancelSave ? null : "/tmp/사진 모음.pdf";
    }
    if (cmd === "pdf_save_document")
      return { ...payload, path: args.targetPath, revision: 1 };
    if (cmd === "draft_delete") return;
    throw new Error(`Unexpected command: ${cmd}`);
  });
  try {
    await openImagesAsPdf(["/tmp/first.png", "/tmp/second.jpg"], "사진 모음");
    assert.equal(activeTab()?.pageCount, 2);
    assert.equal(activeTab()?.pageDirty, true);
    assert.equal(activeTab()?.isUnsaved, true);
    assert.deepEqual(commands, ["pdf_create_from_images"]);
    assert.equal(await saveActivePdf(), false);
    assert.equal(activeTab()?.isUnsaved, true);
    assert.equal(activeTab()?.pageDirty, true);
    cancelSave = false;
    assert.equal(await saveActivePdf(), true);
    assert.equal(activeTab()?.path, "/tmp/사진 모음.pdf");
    assert.equal(activeTab()?.isUnsaved, false);
    assert.equal(activeTab()?.pageDirty, false);
  } finally {
    clearMocks();
    setDocumentStore({ tabs: [], activeTabId: null });
  }
});

test("export writes an image document copy and leaves the source editable", async () => {
  let exported = false;
  mockIPC((cmd, args: any) => {
    if (cmd === "pdf_create_from_images") return payload;
    if (cmd === "plugin:dialog|save") {
      assert.equal(args.options.defaultPath, "사진 모음.pdf");
      return "/tmp/export.pdf";
    }
    if (cmd === "export_annotated_pdf") {
      assert.equal(args.docId, payload.id);
      assert.equal(args.targetPath, "/tmp/export.pdf");
      exported = true;
      return;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
  try {
    await openImagesAsPdf(["/tmp/first.png"], "사진 모음");
    await exportAnnotatedPdfFile();
    assert.equal(exported, true);
    assert.equal(activeTab()?.isUnsaved, true);
    assert.equal(activeTab()?.pageDirty, true);
  } finally {
    clearMocks();
    setDocumentStore({ tabs: [], activeTabId: null });
  }
});

test("conversion failure preserves existing tabs and the import can be retried", async () => {
  let fail = false;
  mockIPC((cmd) => {
    if (cmd === "pdf_create_from_images") {
      if (fail) throw new Error("이미지를 읽을 수 없습니다");
      return payload;
    }
    throw new Error(`Unexpected command: ${cmd}`);
  });
  try {
    await openImagesAsPdf(["/tmp/first.png"], "사진 모음");
    const existingTabId = activeTab()?.tabId;
    fail = true;
    await assert.rejects(
      openImagesAsPdf(["/tmp/broken.png"], "실패"),
      /이미지를 읽을 수 없습니다/,
    );
    assert.equal(activeTab()?.tabId, existingTabId);
    fail = false;
    await openImagesAsPdf(["/tmp/valid.png"], "재시도");
    assert.notEqual(activeTab()?.tabId, existingTabId);
  } finally {
    clearMocks();
    setDocumentStore({ tabs: [], activeTabId: null });
  }
});

test("image list preserves order, skips duplicates and rejects more than 100 images", async () => {
  const {
    addImagePaths,
    imagePaths,
    imageImportError,
    setImagePaths,
    moveImage,
  } = await import("../src/images/importState");
  setImagePaths([]);
  addImagePaths(["/a.png", "/b.JPG", "/a.png", "/unsupported.pdf"]);
  assert.deepEqual(imagePaths(), ["/a.png", "/b.JPG"]);
  assert.match(imageImportError(), /지원하는 형식/);
  moveImage(1, -1);
  assert.deepEqual(imagePaths(), ["/b.JPG", "/a.png"]);
  moveImage(0, -1);
  assert.deepEqual(imagePaths(), ["/b.JPG", "/a.png"]);
  addImagePaths(Array.from({ length: 100 }, (_, i) => `/image-${i}.png`));
  assert.equal(imagePaths().length, 2);
  assert.match(imageImportError(), /100장/);
  setImagePaths([]);
});

test("an edit during a pending save stays dirty", async () => {
  const { addAnnotation, updateAnnotationTextLive } =
    await import("../src/annotations/store");
  let release!: () => void;
  let started!: () => void;
  const saving = new Promise<void>((resolve) => {
    started = resolve;
  });
  mockIPC(async (cmd) => {
    if (cmd === "pdf_create_from_images") return payload;
    if (cmd === "pdf_save_document") {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...payload, path: "/tmp/real.pdf", revision: 1 };
    }
    if (cmd === "plugin:dialog|save") return "/tmp/real.pdf";
    if (cmd === "draft_delete") return;
    throw new Error(`Unexpected command ${cmd}`);
  });
  try {
    await openImagesAsPdf(["/tmp/one.png"]);
    const tab = activeTab()!;
    addAnnotation({
      id: "text",
      page: 0,
      type: "text",
      rect: { x: 1, y: 1, w: 20, h: 20 },
      style: { color: "#000", width: 1 },
      payload: { text: "before" },
    });
    const pending = saveActivePdf();
    await saving;
    updateAnnotationTextLive("text", "after", "after");
    release();
    assert.equal(await pending, true);
    assert.equal(activeTab()?.pageDirty, false);
    assert.equal(activeTab()?.annotations.dirty, true);
    assert.equal(activeTab()?.annotations.items[0].payload?.text, "after");
  } finally {
    clearMocks();
    setDocumentStore({ tabs: [], activeTabId: null });
  }
});

test("an image drop finishes on the original tab after switching tabs", async () => {
  const { handleImageDrop } = await import("../src/viewer/imageDrop");
  const { setActiveTab, documentStore } = await import("../src/state/document");
  let release!: (bytes: Uint8Array) => void;
  let started!: () => void;
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  setDesktopForTests({
    invoke: async () => payload,
    readFile: async () => {
      started();
      return new Promise((resolve) => {
        release = resolve;
      });
    },
  } as any);
  const frame = document.createElement("div");
  frame.className = "page-frame";
  frame.dataset.pageIndex = "0";
  Object.assign(globalThis, {
    HTMLElement: dom.window.HTMLElement,
    Image: class {
      naturalWidth = 100;
      naturalHeight = 100;
      onload = () => {};
      set src(_value: string) {
        queueMicrotask(() => this.onload());
      }
    },
  });
  Object.defineProperty(document, "elementsFromPoint", {
    configurable: true,
    value: () => [frame],
  });
  try {
    await openImagesAsPdf(["/tmp/first.png"]);
    const first = activeTab()!.tabId;
    await openImagesAsPdf(["/tmp/second.png"]);
    const second = activeTab()!.tabId;
    setActiveTab(first);
    const pending = handleImageDrop(["/tmp/drop.png"], { x: 1, y: 1 });
    await reading;
    setActiveTab(second);
    release(new Uint8Array([1, 2, 3]));
    await pending;
    assert.equal(
      documentStore.tabs.find((tab) => tab.tabId === first)?.annotations.items
        .length,
      1,
    );
    assert.equal(
      documentStore.tabs.find((tab) => tab.tabId === second)?.annotations.items
        .length,
      0,
    );
  } finally {
    clearMocks();
    setDocumentStore({ tabs: [], activeTabId: null });
  }
});

test("tab close cancel preserves the dirty tab and backend document", async () => {
  const { closeTab } = await import("../src/ipc/pdf");
  const commands: string[] = [];
  setDesktopForTests({
    invoke: async (cmd: string) => {
      commands.push(cmd);
      return payload;
    },
    confirmUnsaved: async () => "cancel",
  } as any);
  try {
    await openImagesAsPdf(["/tmp/first.png"], "first");
    const original = activeTab()!.tabId;
    await closeTab(original);
    assert.equal(activeTab()?.tabId, original);
    assert.equal(commands.includes("pdf_close"), false);
  } finally {
    clearMocks();
    setDocumentStore({ tabs: [], activeTabId: null });
  }
});

test("approved discard bypasses beforeunload while cancel preserves it", async () => {
  const { attachCloseGuard } = await import("../src/ipc/closeGuard");
  let requestClose!: () => Promise<void>;
  let choice = "cancel";
  let exits = 0;
  setDesktopForTests({
    invoke: async (cmd: string) => {
      if (cmd === "request_app_exit") {
        const event = new dom.window.Event("beforeunload", {
          cancelable: true,
        });
        window.dispatchEvent(event);
        assert.equal(event.defaultPrevented, false);
        exits++;
        return;
      }
      return payload;
    },
    confirmUnsaved: async () => choice,
    listen: async (_name: string, handler: () => Promise<void>) => {
      requestClose = handler;
      return () => {};
    },
  } as any);
  let cleanup = () => {};
  try {
    await openImagesAsPdf(["/tmp/first.png"], "first");
    cleanup = attachCloseGuard();
    await Promise.resolve();
    await requestClose();
    assert.equal(exits, 0);
    const event = new dom.window.Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    choice = "discard";
    await requestClose();
    assert.equal(exits, 1);
    assert.equal(activeTab()?.pageDirty, true);
  } finally {
    cleanup();
    clearMocks();
    setDocumentStore({ tabs: [], activeTabId: null });
  }
});
