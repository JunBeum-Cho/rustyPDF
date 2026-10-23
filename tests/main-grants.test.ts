import { test } from "node:test";
import assert from "node:assert/strict";
import { PathGrants, draftFileName } from "../electron/grants";

test("save target: ungranted gets requireCurrentPath, save-dialog grant passes", () => {
  const g = new PathGrants();
  assert.deepEqual(g.checkCommand("pdf_save_document", { targetPath: "/x.pdf" }), {
    targetPath: "/x.pdf",
    requireCurrentPath: true,
  });
  g.grant("/x.pdf", { write: true });
  assert.deepEqual(g.checkCommand("pdf_save_document", { targetPath: "/x.pdf" }), {
    targetPath: "/x.pdf",
  });
  g.grant("/dropped.pdf");
  assert.equal(
    g.checkCommand("pdf_save_document", { targetPath: "/dropped.pdf" }).requireCurrentPath,
    true,
  );
});

test("ungranted desktop:write and export targets are rejected", () => {
  const g = new PathGrants();
  g.grant("/opened.pdf");
  assert.equal(g.canWrite("/opened.pdf"), false);
  assert.equal(g.has("/opened.pdf"), true);
  assert.equal(g.has("relative.pdf"), false);
  assert.throws(() => g.checkCommand("export_annotated_pdf", { targetPath: "/o.pdf" }));
  g.grant("/o.pdf", { write: true });
  assert.doesNotThrow(() => g.checkCommand("export_annotated_pdf", { targetPath: "/o.pdf" }));
});

test("source paths must be granted; pdf_open needs absolute pdf", () => {
  const g = new PathGrants();
  assert.throws(() => g.checkCommand("pdf_create_from_images", { paths: ["/a.png"] }));
  assert.throws(() => g.checkCommand("pdf_merge_files", { paths: ["/a.pdf"] }));
  assert.throws(() => g.checkCommand("pdf_insert_file", { path: "/a.pdf", afterIndex: 0 }));
  g.grant("/a.png");
  assert.doesNotThrow(() => g.checkCommand("pdf_create_from_images", { paths: ["/a.png"] }));
  assert.doesNotThrow(() => g.checkCommand("pdf_open", { path: "/any/where.PDF" }));
  assert.throws(() => g.checkCommand("pdf_open", { path: "/etc/passwd" }));
  assert.throws(() => g.checkCommand("pdf_open", { path: "rel.pdf" }));
});

test("draft file names hash the document path", () => {
  const a = draftFileName("/a.pdf");
  assert.match(a, /^[0-9a-f]{64}\.json$/);
  assert.notEqual(a, draftFileName("/b.pdf"));
  assert.equal(a, draftFileName("/a.pdf"));
});

test("open_external allows only http, https and mailto", async () => {
  const { safeExternalUrl } = await import("../electron/grants");
  assert.equal(safeExternalUrl("https://a.test/x"), "https://a.test/x");
  assert.ok(safeExternalUrl("mailto:a@b.test"));
  for (const bad of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "nope", 5])
    assert.throws(() => safeExternalUrl(bad));
});
