import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { physicalDropToClient } from "../src/ipc/dropPosition";

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
  assert.equal(host.querySelector("font")?.getAttribute("face"), "Arial");
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

test("physical drop coordinates hit the same CSS point at different monitor scales", () => {
  for (const ratio of [1, 1.25, 1.5, 2, 3]) {
    const client = physicalDropToClient({ x: 400 * ratio, y: 300 * ratio }, ratio);
    assert.deepEqual(client, { x: 400, y: 300 });
    // The actual page-relative hit remains independent of monitor scale.
    assert.deepEqual({ x: client.x - 100, y: client.y - 50 }, { x: 300, y: 250 });
  }
});
