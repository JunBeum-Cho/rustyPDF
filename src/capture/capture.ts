import { invoke } from "../platform/desktop";
import { save } from "../platform/desktop";
import { writeFile } from "../platform/desktop";
import { activeTab } from "../state/document";

interface CaptureRegionArgs {
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  scale?: number;
}

// The backend scale is based on 96 dpi. Capture at 600 dpi so pasted/saved
// regions do not inherit the viewer's zoom or display-resolution bitmap.
const DEFAULT_SCALE = 600 / 96;

export async function captureRegion(
  args: CaptureRegionArgs,
): Promise<ArrayBuffer> {
  const tab = activeTab();
  if (!tab) throw new Error("no active document");
  const result = await invoke<ArrayBuffer | Uint8Array | number[]>(
    "pdf_capture_region",
    {
      docId: tab.docId,
      expectedRevision: tab.revision,
      pageIndex: args.pageIndex,
      x: args.x,
      y: args.y,
      w: args.w,
      h: args.h,
      scale: args.scale ?? DEFAULT_SCALE,
    },
  );
  if (result instanceof ArrayBuffer) return result;
  if (result instanceof Uint8Array) {
    return result.buffer.slice(
      result.byteOffset,
      result.byteOffset + result.byteLength,
    );
  }
  return new Uint8Array(result).buffer;
}

/** Write rendered PNG bytes through the native desktop clipboard. */
export async function copyPngToClipboard(buf: ArrayBuffer): Promise<void> {
  await invoke("clipboard_write_png", { bytes: new Uint8Array(buf) });
}

/** Wait for the capture before writing the native clipboard. */
export async function copyDeferredPngToClipboard(
  pngPromise: Promise<ArrayBuffer>,
): Promise<void> {
  await copyPngToClipboard(await pngPromise);
}

export async function saveCaptureAs(buf: ArrayBuffer): Promise<boolean> {
  const tab = activeTab();
  const defaultPath = tab
    ? tab.path.replace(/\.pdf$/i, ` p${tab.currentPage + 1} 캡처.png`)
    : "capture.png";
  const target = await save({
    filters: [{ name: "PNG", extensions: ["png"] }],
    defaultPath,
  });
  if (!target) return false;
  await writeFile(target, new Uint8Array(buf));
  return true;
}

export interface ToastAction {
  label: string;
  run: () => void | Promise<void>;
}

export interface ToastOptions {
  actions?: ToastAction[];
  timeoutMs?: number | null;
}

export interface ToastEvent extends ToastOptions {
  message: string;
  kind?: "info" | "error";
}

let toastEmitter: ((event: ToastEvent) => void) | null = null;
export const setToastEmitter = (fn: ((event: ToastEvent) => void) | null) => {
  toastEmitter = fn;
};
export const emitToast = (
  message: string,
  kind: "info" | "error" = "info",
  options: ToastOptions = {},
) => {
  if (toastEmitter) toastEmitter({ message, kind, ...options });
};
