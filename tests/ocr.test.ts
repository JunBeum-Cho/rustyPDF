import test from "node:test";
import assert from "node:assert/strict";
import { normalizeOcr, validOcrPage } from "../electron/ocr";
test("OCR lines normalize, empty differs from malformed", () => {
  assert.deepEqual(normalizeOcr({ text: "", blocks: [] }, 100, 200), {
    text: "",
    lines: [],
  });
  assert.deepEqual(
    normalizeOcr(
      {
        text: "hello",
        blocks: [
          {
            paragraphs: [
              {
                lines: [
                  { text: "hello", bbox: { x0: 10, y0: 20, x1: 50, y1: 60 } },
                ],
              },
            ],
          },
        ],
      },
      100,
      200,
    ).lines,
    [{ text: "hello", x: 0.1, y: 0.1, w: 0.4, h: 0.2 }],
  );
  assert.throws(() => normalizeOcr({}, 100, 200));
  assert.equal(
    validOcrPage({
      text: "",
      lines: [{ text: "x", x: NaN, y: 0, w: 1, h: 1 }],
    }),
    false,
  );
});
// The production engine is also exercised manually against bundled eng+kor models.

test("cancelled OCR discards late completion and schedules no next page", async () => {
  const { runOcrAll, cancelOcr, getDocProgress } =
    await import("../src/ocr/ocr");
  let finish!: () => void;
  const calls: number[] = [];
  const backend = {
    recognize: async (_d: string, _r: number, p: number) => {
      calls.push(p);
      await new Promise<void>((r) => (finish = r));
    },
    flush: async () => {},
  };
  const running = runOcrAll("cancel", 0, 3, backend);
  cancelOcr();
  assert.equal(getDocProgress("cancel")?.current, null);
  finish();
  await running;
  assert.deepEqual(calls, [0]);
  assert.equal(getDocProgress("cancel")?.done, 0);
});
test("current page OCR, failures and retry retain accurate completed count", async () => {
  const { runOcrPage, runOcrAll, getDocProgress } =
    await import("../src/ocr/ocr");
  let fails = true;
  const calls: number[] = [];
  const backend = {
    recognize: async (_d: string, _r: number, p: number) => {
      calls.push(p);
      if (p === 1 && fails) throw Error("bad page");
    },
    flush: async () => {},
  };
  await runOcrPage("retry", 0, 3, 2, backend);
  assert.deepEqual(calls, [2]);
  await runOcrAll("retry", 0, 3, backend);
  assert.equal(getDocProgress("retry")?.done, 2);
  assert.equal(getDocProgress("retry")?.failures[1], "bad page");
  fails = false;
  await runOcrAll("retry", 0, 3, backend);
  assert.equal(getDocProgress("retry")?.done, 3);
  assert.deepEqual(getDocProgress("retry")?.failures, {});
});
test("revision invalidation rejects the late page and stops scheduling", async () => {
  const { runOcrAll, invalidateOcrForDocument, getDocProgress } =
    await import("../src/ocr/ocr");
  let finish!: () => void;
  let calls = 0;
  const backend = {
    recognize: async () => {
      calls++;
      await new Promise<void>((r) => (finish = r));
    },
    flush: async () => {},
  };
  const running = runOcrAll("edited", 0, 2, backend);
  invalidateOcrForDocument("edited", 1, 1);
  finish();
  await running;
  assert.equal(calls, 1);
  assert.equal(getDocProgress("edited")?.done, 0);
  assert.equal(getDocProgress("edited")?.total, 1);
});
