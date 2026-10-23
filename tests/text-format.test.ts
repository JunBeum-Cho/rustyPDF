import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";

const dom = new JSDOM("<!doctype html><html><body></body></html>");
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  Node: dom.window.Node,
  NodeFilter: dom.window.NodeFilter,
  Range: dom.window.Range,
});
const { applyInlineStyle } = await import("../src/annotations/textFormat");

const setup = (html: string) => {
  const editor = document.createElement("div");
  editor.innerHTML = html;
  document.body.appendChild(editor);
  return editor;
};

test("partial selection colour wraps only the selected text", () => {
  const editor = setup("hello world");
  const text = editor.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, 6);
  range.setEnd(text, 11);
  applyInlineStyle(range, { color: "#ff0000" });
  assert.equal(editor.textContent, "hello world");
  const spans = editor.querySelectorAll("span");
  assert.equal(spans.length, 1);
  assert.equal(spans[0].textContent, "world");
  assert.equal(spans[0].style.color, "rgb(255, 0, 0)");
  assert.equal(editor.firstChild?.textContent, "hello ");
});

test("existing span covering the same text is reused", () => {
  const editor = setup('a<span style="color: blue; font-weight: bold">bc</span>d');
  const range = document.createRange();
  range.selectNodeContents(editor.querySelector("span")!);
  applyInlineStyle(range, { color: "#00ff00" });
  assert.equal(editor.querySelectorAll("span").length, 1);
  const span = editor.querySelector("span")!;
  assert.equal(span.style.color, "rgb(0, 255, 0)");
  assert.equal(span.style.fontWeight, "bold");
});

test("nested spans: the property is cleaned from descendants", () => {
  const editor = setup('<span style="font-size: 30px">x<span style="font-size: 10px">yz</span></span>');
  const range = document.createRange();
  range.selectNodeContents(editor);
  applyInlineStyle(range, { fontSize: 20 });
  assert.equal(editor.textContent, "xyz");
  const sizes = [...editor.querySelectorAll<HTMLElement>("[style]")].map((e) => e.style.fontSize);
  assert.ok(sizes.every((s) => s === "20px"), sizes.join(","));
  assert.ok(!editor.innerHTML.includes("30px") && !editor.innerHTML.includes("10px"));
});

test("collapsed range is a no-op", () => {
  const editor = setup("abc");
  const range = document.createRange();
  range.setStart(editor.firstChild!, 1);
  range.collapse(true);
  assert.equal(applyInlineStyle(range, { color: "#ff0000" }), null);
  assert.equal(editor.innerHTML, "abc");
});

test("Korean text stays intact across splits", () => {
  const editor = setup("한글 입력기 테스트");
  const text = editor.firstChild as Text;
  const range = document.createRange();
  range.setStart(text, 3);
  range.setEnd(text, 6);
  applyInlineStyle(range, { fontFamily: "Arial", fontSize: 18 });
  assert.equal(editor.textContent, "한글 입력기 테스트");
  assert.equal(editor.querySelector("span")?.textContent, "입력기");
});
