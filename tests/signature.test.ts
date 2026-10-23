import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_SIGNATURES,
  addSignature,
  loadSignatures,
  removeSignature,
  trimBounds,
  type SignatureStorage,
} from "../src/annotations/SignatureDialog";

const fakeStorage = (): SignatureStorage & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
  };
};

test("trimBounds crops transparent margins", () => {
  const w = 10, h = 8;
  const alpha = new Uint8ClampedArray(w * h);
  alpha[2 * w + 3] = 255;
  alpha[5 * w + 6] = 10;
  assert.deepEqual(trimBounds(alpha, w, h), { x: 3, y: 2, w: 4, h: 4 });
});

test("trimBounds returns null for fully transparent", () => {
  assert.equal(trimBounds(new Uint8ClampedArray(20), 5, 4), null);
});

test("saved list keeps newest first and caps at five", () => {
  const s = fakeStorage();
  for (let i = 0; i < 7; i++) addSignature(`data:${i}`, s);
  const list = loadSignatures(s);
  assert.equal(list.length, MAX_SIGNATURES);
  assert.deepEqual(list, ["data:6", "data:5", "data:4", "data:3", "data:2"]);
  removeSignature("data:4", s);
  assert.deepEqual(loadSignatures(s), ["data:6", "data:5", "data:3", "data:2"]);
});

test("storage failures and bad data are tolerated", () => {
  const bad: SignatureStorage = {
    getItem: () => { throw new Error("x"); },
    setItem: () => { throw new Error("x"); },
  };
  assert.deepEqual(loadSignatures(bad), []);
  assert.deepEqual(addSignature("a", bad), ["a"]);
  const s = fakeStorage();
  s.setItem("rustpdf.signatures", "{oops");
  assert.deepEqual(loadSignatures(s), []);
});
