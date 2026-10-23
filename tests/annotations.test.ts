import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, { window: dom.window, document: dom.window.document });
const { sanitizeAnnotationHtml, sanitizeAnnotation, insertSafeEditorTransfer } =
  await import("../src/annotations/sanitize");

test("sidecar HTML removes executable/resource markup and UI impersonation", () => {
  const malicious = `<div id="app" class="toolbar" onclick="alert(1)" style="position:fixed;inset:0;background-image:url(https://invalid.test/a);color:red">
    <img src=x onerror=alert(1)><svg onload=alert(1)><a href="javascript:alert(1)">x</a></svg>
    <iframe srcdoc="<script>alert(1)</script>"></iframe><script>alert(1)</script>
    <form><input name="__TAURI_INTERNALS__"></form><a href="javascript:alert(1)">keep text</a>
    <span style="font-size:18px;background-color:#fff">safe</span></div>`;
  const safe = sanitizeAnnotationHtml(malicious);
  const host = document.createElement("div");
  host.innerHTML = safe;
  assert.equal(host.querySelector("img,svg,iframe,script,form,input,a"), null);
  assert.equal(host.querySelector("[id],[class],[onclick],[onerror],[href],[src]"), null);
  assert.ok(!safe.includes("url(") && !safe.includes("position:") && !safe.includes("inset:"));
  assert.match(host.textContent ?? "", /keep text/);
  assert.match(safe, /font-size: 18px/);
  assert.match(safe, /color: red/);
  assert.equal(sanitizeAnnotationHtml(safe), safe);
});

test("rich text keeps Korean, line breaks, font, alignment and emphasis", () => {
  const html = `<div style="text-align:center"><font face="Arial" size="4" color="#123456"><b>한글</b><i> italic</i><u> 밑줄</u></font><br><span style="font-family:Arial;font-size:24px;font-weight:700;line-height:1.4">second</span></div>`;
  const safe = sanitizeAnnotationHtml(html);
  const host = document.createElement("div");
  host.innerHTML = safe;
  assert.equal(host.querySelector("b")?.textContent, "한글");
  assert.equal(host.querySelectorAll("i,u,br,font").length, 4);
  assert.equal(host.querySelector("div")?.style.textAlign, "center");
  assert.equal(host.querySelector("span")?.style.fontSize, "24px");
  assert.equal(host.querySelector("font")?.getAttribute("face"), "Noto Sans KR");
});

test("sidecar normalization does not mutate the source or strip image annotations", () => {
  const annotation = { id: "a", page: 0, type: "text" as const, style: { color: "#000", width: 1 }, payload: { html: '<b onclick="bad()">hello</b>' } };
  const clean = sanitizeAnnotation(annotation);
  assert.equal(clean.payload?.html, "<b>hello</b>");
  assert.match(annotation.payload.html, /onclick/);
  const image = { ...annotation, type: "image" as const, payload: { imageSrc: "data:image/png;base64,AAAA" } };
  assert.equal(sanitizeAnnotation(image).payload?.imageSrc, image.payload.imageSrc);
});

test("paste sanitizes before inserting and escapes plain text", () => {
  const inserted: string[] = [];
  document.execCommand = (command, _ui, value) => {
    assert.equal(command, "insertHTML");
    inserted.push(value ?? "");
    return true;
  };
  const transfer = (html: string, plain: string) => ({ getData: (type: string) => type === "text/html" ? html : plain }) as DataTransfer;
  insertSafeEditorTransfer(transfer('<b onmouseover="bad()">safe</b><img src=x onerror=bad()>', ""));
  insertSafeEditorTransfer(transfer("", "<script> &\n한글"));
  assert.deepEqual(inserted, ["<b>safe</b>", "&lt;script&gt; &amp;<br>한글"]);
});

test("paste adopts the text box appearance instead of invisible OCR or white source styling", () => {
  let inserted = "";
  document.execCommand = (_command, _ui, value) => {
    inserted = value ?? "";
    return true;
  };
  const html = `<div style="color:white;background-color:black;font-family:Arial;font-size:80px;line-height:80px;letter-spacing:12px"><font color="#ffffff" face="Arial" size="7"><b>인식한 글자</b></font><br><span style="color:transparent;font-size:100px"><i>둘째 줄</i></span></div>`;
  insertSafeEditorTransfer({ getData: (type: string) => type === "text/html" ? html : "인식한 글자\n둘째 줄" } as DataTransfer);
  const host = document.createElement("div");
  host.innerHTML = inserted;
  assert.equal(host.querySelector("[style],[color],[face],[size]"), null);
  assert.equal(host.querySelector("b")?.textContent, "인식한 글자");
  assert.equal(host.querySelector("i")?.textContent, "둘째 줄");
  assert.equal(host.querySelectorAll("br").length, 1);
});

test("paste falls back to plain text when rich clipboard content has no text", () => {
  let inserted = "";
  document.execCommand = (_command, _ui, value) => { inserted = value ?? ""; return true; };
  insertSafeEditorTransfer({ getData: (type: string) => type === "text/html" ? '<img src="invalid">' : "복사한 글자\n다음 줄" } as DataTransfer);
  assert.equal(inserted, "복사한 글자<br>다음 줄");
});

test("pasted annotations are clamped inside the target page and cascade resets on re-copy", async () => {
  const store = await import("../src/annotations/store");
  const { setDocumentStore, activeTab, emptyAnnotationTabState } = await import("../src/state/document");
  const page = { index: 0, width: 200, height: 300, rotation: 0 as const };
  const item = { id: "r", page: 0, type: "rect" as const, rect: { x: 170, y: 270, w: 30, h: 30 }, style: { color: "#000", width: 1 } };
  const tab: any = { tabId: "p", docId: "d", revision: 1, path: "/x.pdf", pageCount: 1, pages: [page], fileSize: 1, contentVersion: 0, zoom: 1,
    currentPage: 0, navigationVersion: 0, selectedPageIndices: [], pageAnchor: null, pageDirty: false, annotations: emptyAnnotationTabState(),
    readOnly: false, readOnlyReason: null, signed: false, formDirty: false };
  tab.annotations.items = [item];
  tab.annotations.selectedIds = ["r"];
  setDocumentStore({ tabs: [tab], activeTabId: "p" });
  assert.equal(store.duplicateSelectedAnnotations(), true);
  const pasted = activeTab()!.annotations.items[1];
  assert.deepEqual({ ...pasted.rect }, { x: 170, y: 270, w: 30, h: 30 });
  setDocumentStore("tabs", 0, "annotations", "items", [{ ...item, rect: { x: 10, y: 10, w: 20, h: 20 } }]);
  setDocumentStore("tabs", 0, "annotations", "selectedIds", ["r"]);
  store.copySelectedAnnotations();
  store.pasteAnnotations();
  store.pasteAnnotations();
  const [, first, second] = activeTab()!.annotations.items;
  assert.deepEqual([first.rect!.x, second.rect!.x], [26, 42]);
  store.selectAnnotation("r");
  store.copySelectedAnnotations();
  store.pasteAnnotations();
  assert.equal(activeTab()!.annotations.items[3].rect!.x, 26);
});

test("text color defaults to black and stays independent of drawing color", async () => {
  const { annotationStore, setAnnotationTool, setAnnotationUiColor } = await import("../src/annotations/store");
  const { documentStore, setDocumentStore } = await import("../src/state/document");
  const previous = { ...documentStore.annotationUi };
  try {
    assert.equal(annotationStore.textColor, "#000000");
    setAnnotationTool("pen");
    setAnnotationUiColor("#2563eb");
    setAnnotationTool("text");
    assert.equal(annotationStore.color, "#000000");
    setAnnotationUiColor("#64748b");
    setAnnotationTool("pen");
    assert.equal(annotationStore.color, "#2563eb");
    setAnnotationTool("text");
    assert.equal(annotationStore.color, "#64748b");
  } finally { setDocumentStore("annotationUi", previous); }
});

test("PDF/OCR copy writes plain text while annotation copy retains rich formatting", async () => {
  const { copyPageText } = await import("../src/ocr/copyText");
  const host = document.createElement("div");
  host.innerHTML = '<div class="ocr-text-layer"><span style="color:transparent">인식한 글자</span></div><div class="ocr-text-layer">둘째 페이지</div><div contenteditable="true"><b>강조한 주석</b></div>';
  document.body.append(host);
  const selection = window.getSelection()!;
  try {
    const range = document.createRange();
    range.setStart(host.children[0].firstChild!.firstChild!, 0);
    range.setEnd(host.children[1].firstChild!, 6);
    selection.removeAllRanges(); selection.addRange(range);
    const data = new Map<string, string>([["text/html", '<span style="color:transparent">bad</span>']]);
    let prevented = false;
    const event = {
      defaultPrevented: false,
      clipboardData: { clearData: () => data.clear(), setData: (type: string, value: string) => data.set(type, value) },
      preventDefault: () => { prevented = true; },
    } as unknown as ClipboardEvent;
    const expected = selection.toString();
    copyPageText(event);
    assert.equal(prevented, true);
    assert.deepEqual([...data], [["text/plain", expected]]);
    prevented = false;
    // A native input selection can leave the previous PDF DOM range intact.
    const input = document.createElement("input");
    copyPageText({ ...event, target: input } as unknown as ClipboardEvent);
    assert.equal(prevented, false);
    range.selectNodeContents(host.children[2]);
    selection.removeAllRanges(); selection.addRange(range);
    copyPageText(event);
    assert.equal(prevented, false);
    selection.collapseToStart();
    copyPageText(event);
    assert.equal(prevented, false);
  } finally { selection.removeAllRanges(); host.remove(); }
});
