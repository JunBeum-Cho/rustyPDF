import assert from "node:assert/strict";
import test from "node:test";
import {
  closeSequentially,
  moveTab,
  tabLabels,
  tabsToClose,
} from "../src/tabs/tabOrder.ts";

const t = (tabId: string, path: string) => ({ tabId, path });

test("tabLabels disambiguates same file names with parent folder", () => {
  const labels = tabLabels([
    t("a", "/x/docs/a.pdf"),
    t("b", "/x/work/a.pdf"),
    t("c", "/x/work/b.pdf"),
  ]);
  assert.deepEqual(labels, {
    a: "a.pdf — docs",
    b: "a.pdf — work",
    c: "b.pdf",
  });
});

test("tabLabels handles windows paths", () => {
  const labels = tabLabels([t("a", "C:\\p\\q\\a.pdf"), t("b", "C:\\r\\a.pdf")]);
  assert.equal(labels.a, "a.pdf — q");
  assert.equal(labels.b, "a.pdf — r");
});

test("moveTab reorders", () => {
  const tabs = [t("a", "a"), t("b", "b"), t("c", "c")];
  assert.deepEqual(moveTab(tabs, 0, 2).map((x) => x.tabId), ["b", "c", "a"]);
  assert.deepEqual(moveTab(tabs, 2, 0).map((x) => x.tabId), ["c", "a", "b"]);
  assert.equal(moveTab(tabs, 1, 1), tabs);
  assert.equal(moveTab(tabs, 5, 0), tabs);
});

test("close others / right keep order and exclude target", () => {
  const tabs = [t("a", "a"), t("b", "b"), t("c", "c"), t("d", "d")];
  assert.deepEqual(tabsToClose(tabs, "b", "others"), ["a", "c", "d"]);
  assert.deepEqual(tabsToClose(tabs, "b", "right"), ["c", "d"]);
  assert.deepEqual(tabsToClose(tabs, "b", "self"), ["b"]);
});

test("closeSequentially runs one at a time and stops if a tab stays open", async () => {
  const log: string[] = [];
  const open = new Set(["a", "b", "c"]);
  await closeSequentially(
    ["a", "b", "c"],
    async (id) => {
      log.push(`start ${id}`);
      await new Promise((r) => setTimeout(r, 1));
      if (id !== "b") open.delete(id);
      log.push(`end ${id}`);
    },
    (id) => open.has(id),
  );
  assert.deepEqual(log, ["start a", "end a", "start b", "end b"]);
});
