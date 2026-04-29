import { onCleanup, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { documentStore, fileNameFromPath } from "../state/document";
import { ask } from "@tauri-apps/plugin-dialog";
import { flushAnnotationSaveForTab, savePdfToPath } from "./pdf";

const hasUnsavedTabs = () =>
  documentStore.tabs.some((t) => t.annotations.dirty || t.pageDirty);

export function installCloseGuard() {
  onMount(() => {
    let unlisten: (() => void) | undefined;
    let allowingClose = false;

    (async () => {
      try {
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested(async (event) => {
          if (allowingClose || !hasUnsavedTabs()) return;
          event.preventDefault();
          const dirtyNames = documentStore.tabs
            .filter((t) => t.annotations.dirty || t.pageDirty)
            .map((t) => fileNameFromPath(t.path));
          let save = false;
          try {
            save = await ask(
              `저장되지 않은 변경사항이 있습니다:\n${dirtyNames.join("\n")}\n\n저장하시겠습니까?`,
              { title: "rustpdf", kind: "warning", okLabel: "저장 후 닫기", cancelLabel: "저장 안 함" },
            );
          } catch {
            save = window.confirm("저장되지 않은 변경사항이 있습니다. 저장 후 닫으시겠습니까?");
          }
          if (save) {
            for (const tab of documentStore.tabs) {
              try {
                if (tab.annotations.dirty) {
                  await flushAnnotationSaveForTab(tab.tabId);
                }
                if (tab.pageDirty) {
                  await savePdfToPath(tab.docId, tab.path);
                }
              } catch (error) {
                console.error("close-guard save failed", tab.path, error);
                const force = window.confirm(
                  `${fileNameFromPath(tab.path)} 저장에 실패했습니다. 그래도 닫으시겠습니까?`,
                );
                if (!force) return;
              }
            }
          }
          allowingClose = true;
          await win.destroy();
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
      unlisten?.();
      window.removeEventListener("beforeunload", onBeforeUnload);
    });
  });
}
