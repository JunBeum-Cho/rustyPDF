import { onCleanup, onMount } from "solid-js";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { documentStore, fileNameFromPath } from "../state/document";
import { ask } from "@tauri-apps/plugin-dialog";
import { saveTabPdf } from "./pdf";

const hasUnsavedTabs = () =>
  documentStore.tabs.some((t) => t.annotations.dirty || t.pageDirty);

export function installCloseGuard() {
  onMount(() => {
    let unlistenWindow: (() => void) | undefined;
    let unlistenAppClose: (() => void) | undefined;
    let allowingClose = false;
    let closeFlowRunning = false;

    const requestAppExit = async () => {
      try {
        await invoke("request_app_exit");
      } catch (error) {
        console.error("app exit request failed", error);
      }
    };

    const handleCloseRequest = async () => {
      if (allowingClose || closeFlowRunning) return;
      closeFlowRunning = true;

      try {
        if (hasUnsavedTabs()) {
          const dirtyNames = documentStore.tabs
            .filter((t) => t.annotations.dirty || t.pageDirty)
            .map((t) => fileNameFromPath(t.path));
          let save = false;
          try {
            save = await ask(
              `저장되지 않은 변경사항이 있습니다:\n${dirtyNames.join("\n")}\n\n저장하시겠습니까?`,
              {
                title: "RustyPDF",
                kind: "warning",
                okLabel: "저장 후 닫기",
                cancelLabel: "저장 안 함",
              },
            );
          } catch {
            save = window.confirm(
              "저장되지 않은 변경사항이 있습니다. 저장 후 닫으시겠습니까?",
            );
          }
          if (save) {
            for (const tab of documentStore.tabs) {
              try {
                await saveTabPdf(tab.tabId);
              } catch (error) {
                console.error("close-guard save failed", tab.path, error);
                const force = window.confirm(
                  `${fileNameFromPath(tab.path)} 저장에 실패했습니다. 그래도 닫으시겠습니까?`,
                );
                if (!force) {
                  closeFlowRunning = false;
                  return;
                }
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
        const win = getCurrentWindow();
        unlistenWindow = await win.onCloseRequested(async (event) => {
          if (allowingClose) return;
          event.preventDefault();
          await handleCloseRequest();
        });
        unlistenAppClose = await listen("app-close-requested", async () => {
          await handleCloseRequest();
        });
      } catch (error) {
        console.error("install close guard failed", error);
      }
    })();

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedTabs()) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    onCleanup(() => {
      unlistenWindow?.();
      unlistenAppClose?.();
      window.removeEventListener("beforeunload", onBeforeUnload);
    });
  });
}
