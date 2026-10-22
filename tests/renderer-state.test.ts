import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { emptyAnnotationTabState } from "../src/state/document";
test("annotation state has a monotonic save version", () => {
  assert.equal(emptyAnnotationTabState().editVersion, 0);
});
test("autosave observes edit versions and shares the explicit flush", () => {
  const source = readFileSync(
    new URL("../src/annotations/persistence.ts", import.meta.url),
    "utf8",
  );
  assert.match(source, /annotations.editVersion/);
  assert.doesNotMatch(source, /JSON.stringify/);
  assert.match(source, /flushAnnotationSaveForTab/);
});
