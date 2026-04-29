import { readFile } from "@tauri-apps/plugin-fs";
import { addAnnotation, createAnnotationId } from "../annotations/store";
import type { Annotation } from "../annotations/types";
import { displayPointToPage } from "../annotations/coords";
import { activeTab } from "../state/document";

const EXT_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  tif: "image/tiff",
  tiff: "image/tiff",
};

const mimeFromPath = (path: string): string => {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_MIME[ext] ?? "application/octet-stream";
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  // chunk to avoid call-stack blowups on big images
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK)));
  }
  return btoa(out);
};

const measureImage = (src: string): Promise<{ w: number; h: number }> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = (e) => reject(e);
    img.src = src;
  });

interface PageHit {
  pageIndex: number;
  /** position within the page-frame in display pixels (already CSS px) */
  x: number;
  y: number;
  frameWidth: number;
  frameHeight: number;
}

const findPageHit = (clientX: number, clientY: number): PageHit | null => {
  const elements = document.elementsFromPoint(clientX, clientY);
  for (const el of elements) {
    if (
      el instanceof HTMLElement &&
      el.classList.contains("page-frame") &&
      el.dataset.pageIndex
    ) {
      const rect = el.getBoundingClientRect();
      return {
        pageIndex: Number(el.dataset.pageIndex),
        x: clientX - rect.left,
        y: clientY - rect.top,
        frameWidth: rect.width,
        frameHeight: rect.height,
      };
    }
  }
  return null;
};

/**
 * Handle one or more image files dropped onto the viewer. Each image becomes
 * a new annotation pinned to whatever page sits under the drop point. Sized
 * to roughly 40% of the page width by default, preserving aspect ratio.
 */
export async function handleImageDrop(
  paths: string[],
  position: { x: number; y: number },
): Promise<void> {
  const tab = activeTab();
  if (!tab) return;

  const hit = findPageHit(position.x, position.y);
  if (!hit) {
    console.warn("image drop: no page under cursor");
    return;
  }
  const pageMeta = tab.pages[hit.pageIndex];
  if (!pageMeta) return;

  // Drop position in PDF page coords (origin = top-left, points)
  const dropPagePoint = displayPointToPage(
    { x: hit.x, y: hit.y },
    pageMeta,
    tab.zoom,
    tab.rotation,
  );

  // Stack vertically if multiple images dropped together so they don't pile
  // on the same spot.
  let stackOffset = 0;

  for (const path of paths) {
    try {
      const bytes = await readFile(path);
      const mime = mimeFromPath(path);
      const dataUrl = `data:${mime};base64,${bytesToBase64(bytes)}`;
      const { w, h } = await measureImage(dataUrl);

      // Default size: 40% of the page width, preserve aspect ratio. The user
      // can resize via the existing rect handles after drop.
      const targetWidthPt = pageMeta.width * 0.4;
      const aspect = h > 0 ? h / w : 0.5;
      const targetHeightPt = targetWidthPt * aspect;

      const annotation: Annotation = {
        id: createAnnotationId(),
        page: hit.pageIndex,
        type: "image",
        rect: {
          x: dropPagePoint.x + stackOffset,
          y: dropPagePoint.y + stackOffset,
          w: targetWidthPt,
          h: targetHeightPt,
        },
        style: {
          color: "#000000",
          width: 0,
        },
        payload: {
          imageSrc: dataUrl,
          imageNaturalWidth: w,
          imageNaturalHeight: h,
        },
      };
      addAnnotation(annotation);
      stackOffset += 18;
    } catch (error) {
      console.error("image drop failed for", path, error);
    }
  }
}
