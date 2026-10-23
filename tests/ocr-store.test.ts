import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DiskWatcher } from "../electron/disk-watch.js";
import { OcrCache, remapOcr } from "../electron/ocr-store.js";

const page = (text: string) => ({
  text,
  lines: [{ text, x: 0.1, y: 0.1, w: 0.2, h: 0.1 }],
}) as any;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const tmp = () => mkdtemp(join(tmpdir(), "ocr-store-"));

test("save never throws and load roundtrips, dropping out-of-range", async () => {
  const dir = await tmp();
  const cache = new OcrCache(dir);
  await cache.save("k", new Map([[0, page("a")], [5, page("z")]]));
  const got = await cache.load("k", 2);
  assert.deepEqual([...got.keys()], [0]);
  const blocked = join(dir, "file");
  await writeFile(blocked, "x");
  const bad = new OcrCache(blocked); // dataDir is a file: mkdir fails
  const orig = console.error;
  console.error = () => {};
  try {
    await bad.save("k", new Map([[0, page("a")]]));
  } finally {
    console.error = orig;
  }
  assert.equal((await bad.load("k", 1)).size, 0);
  await rm(dir, { recursive: true });
});

test("legacy file is read-only", async () => {
  const dir = await tmp();
  const pdf = join(dir, "doc.pdf");
  const legacy = `${pdf}.ocr.json`;
  const body = JSON.stringify({
    version: 2,
    pdfFingerprint: "key1",
    pages: { 0: page("old"), 1: { bad: true } },
  });
  await writeFile(legacy, body);
  const cache = new OcrCache(join(dir, "data"));
  const got = await cache.load("key1", 3, pdf);
  assert.equal(got.get(0)?.text, "old");
  assert.equal(got.size, 1);
  assert.equal((await cache.load("other", 3, pdf)).size, 0);
  await cache.save("key1", got);
  assert.equal(await readFile(legacy, "utf8"), body);
  assert.ok(existsSync(join(dir, "data", "ocr", "key1.json")));
  await rm(dir, { recursive: true });
});

test("remapOcr", () => {
  const a = page("a"), b = page("b"), c = page("c");
  const out = remapOcr(new Map([[0, a], [1, b]]), [1, 0], []);
  assert.equal(out.get(1), a);
  assert.equal(out.get(0), b);
  const out2 = remapOcr(new Map([[0, a], [1, b], [2, c]]), [0, null, 1], [1]);
  assert.deepEqual([...out2.keys()], [0]);
});

test("watcher fires once on change, ignores own writes and unsaved", async () => {
  const dir = await tmp();
  const path = join(dir, "a.pdf");
  await writeFile(path, "one");
  const events: string[] = [];
  const w = new DiskWatcher((id) => events.push(id), 20);
  w.watch("d", path, sha("one"));
  w.watch("u", "unsaved://x", "f");
  await sleep(80);
  await writeFile(path, "twotwo");
  w.update("d", path, sha("twotwo"));
  await sleep(120);
  assert.deepEqual(events, []);
  await writeFile(path, "three!!");
  await sleep(150);
  assert.deepEqual(events, ["d"]);
  await sleep(100);
  assert.deepEqual(events, ["d"]);
  await rm(path);
  await sleep(120);
  assert.deepEqual(events, ["d", "d"]);
  w.dispose();
  await rm(dir, { recursive: true });
});
