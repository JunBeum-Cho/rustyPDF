import assert from "node:assert/strict";
import { test } from "node:test";
import {
  flattenOutline,
  isSafeExternalUrl,
  namedActionTarget,
  resolveDestToPageIndex,
} from "../src/viewer/pdfLinks.ts";

test("unsafe URLs are rejected", () => {
  for (const u of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "ftp://a", "", "nope", " JavaScript:1"])
    assert.equal(isSafeExternalUrl(u), false, u);
  for (const u of ["https://a.com", "http://a.com/x", "mailto:a@b.c"])
    assert.equal(isSafeExternalUrl(u), true, u);
});

test("named destination resolves to a page index", async () => {
  const ref = { num: 5, gen: 0 };
  const doc = {
    getDestination: async (id: string) => (id === "chap2" ? [ref, { name: "XYZ" }, 0, 0, null] : null),
    getPageIndex: async (r: unknown) => (r === ref ? 3 : -1),
  };
  assert.equal(await resolveDestToPageIndex(doc, "chap2"), 3);
  assert.equal(await resolveDestToPageIndex(doc, "missing"), null);
  assert.equal(await resolveDestToPageIndex(doc, [ref, { name: "Fit" }]), 3);
  assert.equal(await resolveDestToPageIndex(doc, [7, { name: "Fit" }]), 7);
});

test("named actions", () => {
  assert.equal(namedActionTarget("NextPage", 2, 5), 3);
  assert.equal(namedActionTarget("NextPage", 4, 5), null);
  assert.equal(namedActionTarget("PrevPage", 0, 5), null);
  assert.equal(namedActionTarget("FirstPage", 3, 5), 0);
  assert.equal(namedActionTarget("LastPage", 0, 5), 4);
  assert.equal(namedActionTarget("Print", 0, 5), null);
});

test("nested outline flattens by expansion", () => {
  const tree = [
    { title: "A", dest: "a", items: [{ title: "A1", dest: "a1", items: [{ title: "A1x", dest: "x" }] }, { title: "A2", dest: "a2" }] },
    { title: "B", dest: "b" },
  ];
  assert.deepEqual(flattenOutline(tree, new Set()).map((r) => r.title), ["A", "B"]);
  const rows = flattenOutline(tree, new Set(["0", "0.0"]));
  assert.deepEqual(rows.map((r) => [r.title, r.depth]), [["A", 0], ["A1", 1], ["A1x", 2], ["A2", 1], ["B", 0]]);
  assert.equal(rows[0].hasChildren && rows[0].expanded, true);
  assert.equal(rows[4].hasChildren, false);
});
