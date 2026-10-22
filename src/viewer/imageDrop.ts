import { emitToast } from "../capture/capture";
import { normalizeImageSource } from "../images/normalize";
import { readFile } from "../platform/desktop";
import { createAnnotationId } from "../annotations/store";
import type { Annotation } from "../annotations/types";
import { displayPointToPage } from "../annotations/coords";
import { activeTab, documentStore, updateTabById } from "../state/document";

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
    out += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
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
  const { tabId, docId, revision } = tab;

  const hit = findPageHit(position.x, position.y);
  if (!hit) {
    emitToast("이미지를 넣을 페이지 위에 다시 놓아 주세요.", "error");
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

  let reportedFailure = false;
  const reportFailure = (message: string) => { if (!reportedFailure) { reportedFailure = true; emitToast(message, "error"); } };
  for (const path of paths) {
    try {
      const bytes = await readFile(path);
      // A dropped image is base64-inflated (~1.33×) into a data URL that lives
      // in the annotation store, the sidecar JSON, and every IPC payload. Cap
      // the raw size so a huge file can't freeze the UI / bloat the sidecar.
      const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
      if (bytes.length > MAX_IMAGE_BYTES) {
        console.warn(
          "image drop: file too large, skipping",
          path,
          bytes.length,
        );
        reportFailure("이미지가 너무 큽니다. 20MB 이하 파일로 다시 시도하세요.");
        continue;
      }
      const mime = mimeFromPath(path);
      const dataUrl = await normalizeImageSource(
        `data:${mime};base64,${bytesToBase64(bytes)}`,
      );
      const { w, h } = await measureImage(dataUrl);

      // Default size: 40% of the page width, preserve aspect ratio. The user
      // can resize via the existing rect handles after drop.
      const targetWidthPt = pageMeta.width * 0.4;
      const hasValidNaturalSize =
        Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0;
      const aspect = hasValidNaturalSize ? h / w : 0.5;
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
      const live = documentStore.tabs.find(
        (candidate) => candidate.tabId === tabId,
      );
      if (!live || live.docId !== docId || live.revision !== revision) return;
      updateTabById(tabId, (target) => {
        target.annotations.history.push(
          target.annotations.items.map((item) =>
            JSON.parse(JSON.stringify(item)),
          ),
        );
        if (target.annotations.history.length > 80)
          target.annotations.history.shift();
        target.annotations.future = [];
        target.annotations.items.push(annotation);
        target.annotations.selectedIds = [annotation.id];
        target.annotations.editVersion += 1;
        target.annotations.dirty = true;
        target.annotations.saveStatus = "idle";
        target.annotations.saveError = null;
      });
      stackOffset += 18;
    } catch (error) {
      console.error("image drop failed for", path, error);
      reportFailure("이미지를 추가하지 못했습니다. 파일을 확인하고 다시 놓아 주세요.");
    }
  }
}
