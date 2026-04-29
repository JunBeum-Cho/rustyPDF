import { getCurrentWebview } from "@tauri-apps/api/webview";
import { onCleanup, onMount } from "solid-js";
import { initialOpenPath, openPdf, requestOpenPdf } from "./pdf";

const firstPdfPath = (paths: string[]) =>
  paths.find((path) => path.toLowerCase().endsWith(".pdf"));

export function installFileOpenHandlers() {
  onMount(() => {
    let disposed = false;
    let unlisten: (() => void) | undefined;

    (async () => {
      try {
        const initialPath = await initialOpenPath();
        if (!disposed && initialPath) {
          await openPdf(initialPath);
        }

        unlisten = await getCurrentWebview().onDragDropEvent((event) => {
          if (event.payload.type !== "drop") {
            return;
          }
          const path = firstPdfPath(event.payload.paths);
          if (path) {
            void requestOpenPdf(path);
          }
        });
        if (disposed) {
          unlisten();
        }
      } catch (error) {
        console.error("install file open handlers failed", error);
      }
    })();

    onCleanup(() => {
      disposed = true;
      unlisten?.();
    });
  });
}
