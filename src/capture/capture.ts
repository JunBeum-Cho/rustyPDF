import { invoke } from "../platform/desktop";
import { pdfEngine } from "../platform/pdf-engine";
import { save } from "../platform/desktop";
import { writeFile } from "../platform/desktop";
import { activeTab } from "../state/document";

interface CaptureRegionArgs {
  pageIndex: number;
  /** normalized 0..1 of the page */
  x: number;
  y: number;
  w: number;
  h: number;
}

export async function captureRegion(
  args: CaptureRegionArgs,
): Promise<ArrayBuffer> {
  const tab = activeTab();
  if (!tab) throw new Error("no active document");
  return pdfEngine().capture(tab.docId, tab.revision, args);
}

/** Write rendered PNG bytes through the native desktop clipboard. */
export async function copyPngToClipboard(buf: ArrayBuffer): Promise<void> {
  await invoke("clipboard_write_png", { bytes: new Uint8Array(buf) });
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
