import { onCleanup, onMount } from "solid-js";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { annotationStore } from "../annotations/store";
import { flushAnnotationSave, promptUnsavedChanges } from "./pdf";

export function installCloseGuard() {
  onMount(() => {
    let unlisten: (() => void) | undefined;
    let allowingClose = false;

    (async () => {
      try {
        const win = getCurrentWindow();
        unlisten = await win.onCloseRequested(async (event) => {
          if (allowingClose || !annotationStore.dirty) {
            return;
          }
          event.preventDefault();
          const choice = await promptUnsavedChanges();
          if (choice === "cancel") {
            return;
          }
          if (choice === "save") {
            try {
              await flushAnnotationSave();
            } catch (error) {
              const force = window.confirm(
                "저장에 실패했습니다. 그래도 닫으시겠습니까?",
              );
              if (!force) {
                return;
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
      if (!annotationStore.dirty) {
        return;
      }
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
