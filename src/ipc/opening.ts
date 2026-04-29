import { getCurrentWebview } from "@tauri-apps/api/webview";
import { listen } from "@tauri-apps/api/event";
import { onCleanup, onMount } from "solid-js";
import { initialOpenPaths, openPdf, requestOpenPdf } from "./pdf";

const isPdfPath = (path: string) => path.toLowerCase().endsWith(".pdf");
const isImagePath = (path: string) =>
  /\.(png|jpe?g|gif|webp|bmp|svg|tiff?)$/i.test(path);

export interface FileDropHandlers {
  onImagePaths?: (paths: string[], event: { x: number; y: number }) => void;
}

let imageDropHandler:
  | ((paths: string[], event: { x: number; y: number }) => void)
  | null = null;

export const setImageDropHandler = (
  handler: ((paths: string[], event: { x: number; y: number }) => void) | null,
) => {
  imageDropHandler = handler;
};

const openMany = async (paths: string[]) => {
  for (const path of paths) {
    await openPdf(path);
  }
};

export function installFileOpenHandlers() {
  onMount(() => {
    let disposed = false;
    const cleanups: Array<() => void> = [];

    (async () => {
      try {
        const initial = await initialOpenPaths();
        if (!disposed && initial.length > 0) {
          await openMany(initial);
        }

        const dragUnlisten = await getCurrentWebview().onDragDropEvent(
          (event) => {
            if (event.payload.type !== "drop") return;
            const paths = event.payload.paths;
            const pdfs = paths.filter(isPdfPath);
            const images = paths.filter(isImagePath);
            for (const p of pdfs) {
              void requestOpenPdf(p);
            }
            if (images.length > 0 && imageDropHandler) {
              imageDropHandler(images, {
                x: event.payload.position.x,
                y: event.payload.position.y,
              });
            }
          },
        );
        cleanups.push(dragUnlisten);

        // Runtime "open-pdfs" event from second-instance forwarding (Windows
        // / Linux) and from macOS RunEvent::Opened. Always opens as new tabs.
        const eventUnlisten = await listen<string[]>("open-pdfs", (event) => {
          const paths = (event.payload ?? []).filter(isPdfPath);
          if (paths.length > 0) void openMany(paths);
        });
        cleanups.push(eventUnlisten);

        if (disposed) {
          for (const c of cleanups) c();
        }
      } catch (error) {
        console.error("install file open handlers failed", error);
      }
    })();

    onCleanup(() => {
      disposed = true;
      for (const c of cleanups) c();
    });
  });
}
