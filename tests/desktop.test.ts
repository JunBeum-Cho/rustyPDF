import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertCommand,
  assertSender,
  takeOpenPaths,
} from "../electron/protocol";
test("unknown commands and foreign sender rejected", () => {
  assert.throws(() => assertCommand("exec"));
  assert.throws(() =>
    assertSender("https://evil.test", "file:///app/index.html"),
  );
  assert.doesNotThrow(() =>
    assertSender("file:///app/index.html", "file:///app/index.html"),
  );
});
test("startup queue drains exactly once preserving file order", () => {
  const paths = ["/a.pdf", "/b.pdf", "/a.pdf"];
  assert.deepEqual(takeOpenPaths(paths), ["/a.pdf", "/b.pdf"]);
  assert.deepEqual(paths, []);
});

test("worker failures reject current and future requests and disposal is bounded", async () => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { ServiceWorker } = await import("../electron/worker-client");
  const directory = await mkdtemp(join(tmpdir(), "rustypdf-worker-test-"));
  try {
    const file = join(directory, "worker.cjs");
    await writeFile(file, 'throw new Error("fixture failure");');
    const worker = new ServiceWorker(file, {});
    await assert.rejects(worker.invoke("pdf_open"), /fixture failure|exited/);
    await assert.rejects(worker.invoke("pdf_open"), /fixture failure|exited/);
    await assert.rejects(worker.dispose(), /fixture failure|exited/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
