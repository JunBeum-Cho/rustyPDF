import { onFileDrop } from "../platform/desktop";
import { listen } from "../platform/desktop";
import { onCleanup, onMount } from "solid-js";
import { initialOpenPaths, openPdf } from "./pdf";

import { addImagePaths, imageImportOpen } from "../images/importState";

const isPdfPath = (path: string) => path.toLowerCase().endsWith(".pdf");
const isImagePath = (path: string) =>
  /\.(heic|heif|webp|gif|bmp|tiff?|png|jpe?g)$/i.test(path);

let imageDropHandler:
  ((paths: string[], event: { x: number; y: number }) => void) | null = null;

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
        const dragUnlisten = onFileDrop((event) => {
          const paths = event.paths;
          if (imageImportOpen()) {
            addImagePaths(paths);
            return;
          }
          const pdfs = paths.filter(isPdfPath);
          const images = paths.filter(isImagePath);
          for (const p of pdfs) {
            void openPdf(p);
          }
          if (images.length > 0 && imageDropHandler) {
            // Desktop drop positions already use CSS client pixels.
            imageDropHandler(images, event.position);
          }
        });
        cleanups.push(dragUnlisten);

        // Runtime "open-pdfs" event from second-instance forwarding (Windows
        // / Linux) and from macOS RunEvent::Opened. Always opens as new tabs.
        const eventUnlisten = await listen<string[]>("open-pdfs", (event) => {
          const paths = (event.payload ?? []).filter(isPdfPath);
          if (paths.length > 0) void openMany(paths);
        });
        cleanups.push(eventUnlisten);
        const initial = await initialOpenPaths();
        if (!disposed && initial.length > 0) {
          await openMany(initial);
        }

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
