import { invoke } from "@tauri-apps/api/core";
import { save } from "@tauri-apps/plugin-dialog";
import { writeFile } from "@tauri-apps/plugin-fs";
import { activeTab } from "../state/document";

interface CaptureRegionArgs {
  pageIndex: number;
  x: number;
  y: number;
  w: number;
  h: number;
  scale?: number;
}

const DEFAULT_SCALE = 2.0; // retina-quality by default

export async function captureRegion(
  args: CaptureRegionArgs,
): Promise<ArrayBuffer> {
  const tab = activeTab();
  if (!tab) throw new Error("no active document");
  const result = await invoke<ArrayBuffer | Uint8Array | number[]>(
    "pdf_capture_region",
    {
      docId: tab.docId,
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

/**
 * Copy a PNG byte buffer to the system clipboard. This works on WebKit
 * (Tauri's macOS webview) ONLY when the call runs synchronously inside the
 * triggering user gesture — otherwise WebKit treats the gesture as expired
 * and rejects the write. Since the caller almost always wants to await
 * async render work first, we keep `copyPngToClipboard` for already-resolved
 * data and expose `copyDeferredPngToClipboard` for the gesture-preserving
 * pattern below.
 */
export async function copyPngToClipboard(buf: ArrayBuffer): Promise<void> {
  const blob = new Blob([buf], { type: "image/png" });
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob }),
  ]);
}

/**
 * Gesture-preserving clipboard copy: invoke this synchronously from inside
 * the user-event handler (pointerup, click, etc.) and pass a Promise that
 * resolves to the PNG bytes. WebKit/Safari accepts a Promise inside
 * `ClipboardItem` and treats the write as belonging to the still-live
 * gesture — so async backend work doesn't blow up the permission check.
 */
export async function copyDeferredPngToClipboard(
  pngPromise: Promise<ArrayBuffer>,
): Promise<void> {
  // Build the ClipboardItem now (during the gesture). The browser holds
  // onto the Promise<Blob> and resolves it later. If the Promise rejects
  // the clipboard write fails, but we never lose the user-activation
  // window.
  const blobPromise = pngPromise.then(
    (buf) => new Blob([buf], { type: "image/png" }),
  );
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blobPromise }),
  ]);
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
