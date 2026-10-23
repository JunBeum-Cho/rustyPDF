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

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const fake = (opts: { text?: Set<number>; log?: string[] } = {}) => {
  const gates: Array<() => void> = [];
  return {
    gates,
    recognize: async (d: string, _r: number, p: number) => {
      opts.log?.push(`${d}:${p}`);
      await new Promise<void>((r) => gates.push(r));
    },
    hasText: async (_d: string, _r: number, p: number) =>
      opts.text?.has(p) ?? false,
    status: async () => [] as number[],
    flush: async () => {},
  };
};
const release = async (b: { gates: Array<() => void> }) => {
  await tick();
  b.gates.shift()?.();
  await tick();
};

test("second document queues behind the active run, FIFO", async () => {
  const { runOcrAll, getDocProgress } = await import("../src/ocr/ocr");
  const log: string[] = [];
  const b = fake({ log });
  const a = runOcrAll("qa", 0, 1, b);
  const c = runOcrAll("qb", 0, 1, b);
  await tick();
  assert.equal(getDocProgress("qb")?.waiting, true);
  assert.deepEqual(log, ["qa:0"]);
  await release(b);
  await a;
  await tick();
  assert.deepEqual(log, ["qa:0", "qb:0"]);
  assert.equal(getDocProgress("qb")?.waiting, false);
  await release(b);
  await c;
  assert.equal(getDocProgress("qb")?.done, 1);
});

test("starting a queued or active doc again is a no-op", async () => {
  const { runOcrAll } = await import("../src/ocr/ocr");
  const log: string[] = [];
  const b = fake({ log });
  const a = runOcrAll("noop", 0, 1, b);
  await runOcrAll("noop", 0, 1, b);
  await release(b);
  await a;
  assert.deepEqual(log, ["noop:0"]);
});

test("whole-document run skips pages with text, single page does not", async () => {
  const { runOcrAll, runOcrPage, getDocProgress } =
    await import("../src/ocr/ocr");
  const log: string[] = [];
  const b = fake({ log, text: new Set([0, 2]) });
  const all = runOcrAll("skip", 0, 3, b);
  await release(b);
  await all;
  assert.deepEqual(log, ["skip:1"]);
  assert.equal(getDocProgress("skip")?.skipped, 2);
  const one = runOcrPage("skip", 0, 3, 0, b);
  await release(b);
  await one;
  assert.deepEqual(log, ["skip:1", "skip:0"]);
});

test("cancel removes the queued run", async () => {
  const { runOcrAll, cancelOcr, getDocProgress } =
    await import("../src/ocr/ocr");
  const log: string[] = [];
  const b = fake({ log });
  const a = runOcrAll("ca", 0, 1, b);
  const c = runOcrAll("cb", 0, 1, b);
  await tick();
  cancelOcr("cb");
  await c;
  assert.equal(getDocProgress("cb")?.waiting, false);
  await release(b);
  await a;
  await tick();
  assert.deepEqual(log, ["ca:0"]);
});

test("cancelled OCR discards late completion and schedules no next page", async () => {
  const { runOcrAll, cancelOcr, getDocProgress } =
    await import("../src/ocr/ocr");
  const log: string[] = [];
  const b = fake({ log });
  const running = runOcrAll("cancel", 0, 3, b);
  await tick();
  cancelOcr("cancel");
  assert.equal(getDocProgress("cancel")?.current, null);
  await release(b);
  await running;
  assert.deepEqual(log, ["cancel:0"]);
  assert.equal(getDocProgress("cancel")?.done, 0);
});

test("includeOcrOnSave defaults to true and persists", async () => {
  const { includeOcrOnSave, setIncludeOcrOnSave } =
    await import("../src/ocr/ocr");
  assert.equal(includeOcrOnSave(), true);
  setIncludeOcrOnSave(false);
  assert.equal(includeOcrOnSave(), false);
  setIncludeOcrOnSave(true);
});
