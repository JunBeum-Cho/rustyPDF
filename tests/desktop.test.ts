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

async function withFixture(
  source: string,
  run: (file: string) => Promise<void>,
) {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const directory = await mkdtemp(join(tmpdir(), "rustypdf-worker-test-"));
  try {
    const file = join(directory, "worker.cjs");
    await writeFile(file, source);
    await run(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("worker that always crashes rejects after restart budget and dispose is bounded", async () => {
  const { PdfWorkerClient } = await import("../electron/worker-client");
  await withFixture('throw new Error("fixture failure");', async (file) => {
    let restarts = 0;
    const worker = new PdfWorkerClient(
      file,
      {},
      { onRestart: () => restarts++ },
    );
    for (let i = 0; i < 30 && restarts < 3; i++)
      await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(worker.invoke("pdf_open"), /PDF 엔진이 중단되었습니다/);
    assert.equal(restarts, 3);
    await assert.rejects(worker.dispose(), /PDF 엔진이 중단되었습니다/);
  });
});

const echoWorker = `
const { parentPort, workerData } = require("node:worker_threads");
parentPort.postMessage({ event: "ready", payload: workerData });
parentPort.on("message", ({ id, command, args }) => {
  if (command === "crash") process.exit(1);
  if (command === "fail") return parentPort.postMessage({ id, error: "boom" });
  if (command === "__dispose") return parentPort.postMessage({ id, result: null });
  parentPort.postMessage({ event: "seen", payload: command });
  parentPort.postMessage({ id, result: { command, args } });
});
`;

test("crash during invoke rejects, respawns, and next invoke works; events forwarded", async () => {
  const { PdfWorkerClient } = await import("../electron/worker-client");
  await withFixture(echoWorker, async (file) => {
    const events: [string, unknown][] = [];
    let restarted: Error | undefined;
    const worker = new PdfWorkerClient(
      file,
      { tag: 1 },
      {
        onEvent: (name, payload) => events.push([name, payload]),
        onRestart: (e) => (restarted = e),
      },
    );
    assert.deepEqual(await worker.invoke("echo", { a: 1 }), {
      command: "echo",
      args: { a: 1 },
    });
    await assert.rejects(worker.invoke("fail"), /boom/);
    await assert.rejects(worker.invoke("crash"), /PDF 엔진이 중단되었습니다/);
    assert.match(restarted?.message ?? "", /PDF 엔진이 중단되었습니다/);
    assert.deepEqual(await worker.invoke("echo2"), {
      command: "echo2",
      args: {},
    });
    assert.ok(events.some(([n, p]) => n === "seen" && p === "echo"));
    assert.equal(events.filter(([n]) => n === "ready").length, 2);
    assert.deepEqual(events[0], ["ready", { tag: 1 }]);
    await worker.dispose();
  });
});

test("dispose never respawns", async () => {
  const { PdfWorkerClient } = await import("../electron/worker-client");
  await withFixture(echoWorker, async (file) => {
    let restarts = 0;
    const worker = new PdfWorkerClient(
      file,
      {},
      { onRestart: () => restarts++ },
    );
    await worker.invoke("echo");
    await worker.dispose();
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(restarts, 0);
    await assert.rejects(worker.invoke("echo"));
  });
});
