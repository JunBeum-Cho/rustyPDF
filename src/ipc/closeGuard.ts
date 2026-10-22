import { onCleanup, onMount } from "solid-js";
import { invoke } from "../platform/desktop";
import { listen } from "../platform/desktop";

import { documentStore, fileNameFromPath } from "../state/document";
import { confirmUnsaved } from "../platform/desktop";
import { saveTabPdfUntilClean } from "./pdf";
import {
  hasPendingDocumentMutations,
  waitForAllDocumentMutations,
} from "./documentMutations";

const hasUnsavedTabs = () =>
  documentStore.tabs.some((t) => t.annotations.dirty || t.pageDirty);

const unsavedTabs = () =>
  documentStore.tabs.filter((t) => t.annotations.dirty || t.pageDirty);

export function attachCloseGuard(): () => void {
  let unlistenAppClose: (() => void) | undefined;
  let allowingClose = false;
  let disposed = false;
  let closeFlowRunning = false;

  const requestAppExit = async () => {
    try {
      await invoke("request_app_exit");
    } catch (error) {
      allowingClose = false;
      console.error("app exit request failed", error);
    }
  };

  const handleCloseRequest = async () => {
    if (allowingClose || closeFlowRunning) return;
    closeFlowRunning = true;

    try {
      await waitForAllDocumentMutations();
      const tabsToSave = unsavedTabs();
      if (tabsToSave.length > 0) {
        const dirtyNames = tabsToSave.map((t) => fileNameFromPath(t.path));
        const choice = await confirmUnsaved(
          `저장되지 않은 변경사항이 있습니다:\n${dirtyNames.join("\n")}\n\n저장하시겠습니까?`,
        );
        if (choice === "cancel") return;
        if (choice === "save") {
          const failedNames: string[] = [];
          for (const tab of tabsToSave) {
            try {
              const saved = await saveTabPdfUntilClean(tab.tabId);
              if (!saved) failedNames.push(fileNameFromPath(tab.path));
            } catch (error) {
              console.error("close-guard save failed", tab.path, error);
              failedNames.push(fileNameFromPath(tab.path));
            }
          }
          if (failedNames.length > 0) {
            const force = window.confirm(
              `다음 파일 저장에 실패했습니다:\n${failedNames.join("\n")}\n\n그래도 닫으시겠습니까?`,
            );
            if (!force) {
              closeFlowRunning = false;
              return;
            }
          }
        }
      }

      allowingClose = true;
      await requestAppExit();
    } finally {
      closeFlowRunning = false;
    }
  };

  (async () => {
    try {
      unlistenAppClose = await listen("app-close-requested", async () => {
        await handleCloseRequest();
      });
      if (disposed) unlistenAppClose();
    } catch (error) {
      console.error("install close guard failed", error);
    }
  })();

  const onBeforeUnload = (event: BeforeUnloadEvent) => {
    if (allowingClose) return;
    if (!hasUnsavedTabs() && !hasPendingDocumentMutations()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", onBeforeUnload);

  return () => {
    disposed = true;
    unlistenAppClose?.();
    window.removeEventListener("beforeunload", onBeforeUnload);
  };
}

export function installCloseGuard() {
  onMount(() => {
    onCleanup(attachCloseGuard());
  });
}
