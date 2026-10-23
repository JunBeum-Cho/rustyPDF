import assert from "node:assert/strict";
import { test } from "node:test";
import { register } from "node:module";
register(`data:text/javascript,${encodeURIComponent('export async function load(url, context, nextLoad) { return url.endsWith(".css") ? { format: "module", source: "", shortCircuit: true } : nextLoad(url, context); }')}`);
const s = await import("../src/images/importState");

test("accepted extensions, case-insensitive", () => {
  s.setImagePaths([]);
  s.addImagePaths(["/a.PNG", "/b.HEIC", "/c.tiff", "/d.webp", "/e.gif", "/f.bmp", "/g.jpeg", "/h.heif", "/i.tif", "/j.jpg", "/k.pdf", "/png"]);
  assert.equal(s.imagePaths().length, 10);
  assert.match(s.imageImportError(), /PNG, JPG/);
});

test("moveImageTo reorders", () => {
  s.setImagePaths(["/a.png", "/b.png", "/c.png"]);
  s.moveImageTo(0, 2);
  assert.deepEqual(s.imagePaths(), ["/b.png", "/c.png", "/a.png"]);
  s.moveImageTo(2, 0);
  s.moveImageTo(1, 9);
  assert.deepEqual(s.imagePaths(), ["/a.png", "/b.png", "/c.png"]);
});

test("cap of 100", () => {
  s.setImagePaths([]);
  s.addImagePaths(Array.from({ length: 100 }, (_, i) => `/${i}.png`));
  assert.equal(s.imagePaths().length, 100);
  s.addImagePaths(["/extra.png"]);
  assert.equal(s.imagePaths().length, 100);
  assert.match(s.imageImportError(), /100/);
});

test("url registry revokes every created url", () => {
  let n = 0;
  const revoked: string[] = [];
  const r = s.createUrlRegistry(() => `blob:${n++}`, u => revoked.push(u));
  r.add("a", new Blob([]));
  r.add("b", new Blob([]));
  r.add("a", new Blob([]));
  assert.deepEqual(revoked, ["blob:0"]);
  r.remove("b");
  r.clear();
  assert.deepEqual(revoked.sort(), ["blob:0", "blob:1", "blob:2"]);
  assert.equal(r.size, 0);
});
