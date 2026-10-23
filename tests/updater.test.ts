import assert from "node:assert/strict";
import { test } from "node:test";
import { initAutoUpdates } from "../electron/updater.ts";

test("no env means no require", () => {
  let loaded = 0;
  initAutoUpdates({ isPackaged: () => true, env: {}, load: () => { loaded++; return {}; }, log: () => {} });
  assert.equal(loaded, 0);
});

test("not packaged means no require", () => {
  let loaded = 0;
  initAutoUpdates({ isPackaged: () => false, env: { RUSTYPDF_UPDATE_URL: "https://x" }, load: () => { loaded++; return {}; }, log: () => {} });
  assert.equal(loaded, 0);
});

test("require failure does not throw", () => {
  const logs: string[] = [];
  initAutoUpdates({ isPackaged: () => true, env: { RUSTYPDF_UPDATE_URL: "https://x" }, load: () => { throw new Error("nope"); }, log: (m) => logs.push(m) });
  assert.equal(logs.length, 1);
});

test("configures generic feed and checks", () => {
  const calls: unknown[] = [];
  const autoUpdater = { setFeedURL: (o: unknown) => calls.push(o), checkForUpdatesAndNotify: () => { calls.push("check"); return Promise.resolve(); } };
  initAutoUpdates({ isPackaged: () => true, env: { RUSTYPDF_UPDATE_URL: "https://u" }, load: () => ({ autoUpdater }), log: () => {} });
  assert.deepEqual(calls, [{ provider: "generic", url: "https://u" }, "check"]);
});
