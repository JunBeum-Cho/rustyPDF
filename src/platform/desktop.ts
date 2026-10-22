import { clearDocumentHistoryRecovery } from "../viewer/documentHistoryRecovery";
import { PdfEngine } from "./pdf-engine";
export type DialogOptions = {
  multiple?: boolean;
  directory?: boolean;
  title?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
  kind?: string;
  okLabel?: string;
  cancelLabel?: string;
};
export interface DesktopBridge {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  open(options: DialogOptions): Promise<string | string[] | null>;
  save(options: DialogOptions): Promise<string | null>;
  ask(message: string, options?: DialogOptions): Promise<boolean>;
  confirmUnsaved(message: string): Promise<"save" | "discard" | "cancel">;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, bytes: Uint8Array): Promise<void>;
  listen(
    name: string,
    handler: (payload: unknown) => void,
  ): (() => void) | Promise<() => void>;
  filePath(file: File): string;
}
let testing: DesktopBridge | null = null;
let engine: PdfEngine | undefined;
export function setDesktopForTests(bridge: DesktopBridge | null) {
  testing = bridge;
  engine?.dispose();
  engine = undefined;
}
function bridge() {
  const value = testing ?? globalThis.window?.desktop;
  if (!value) throw new Error("Electron desktop bridge unavailable");
  return value;
}
export async function invoke<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const host = bridge();
  if (!engine) engine = new PdfEngine((cmd, a) => host.invoke(cmd, a));
  if (
    [
      "pdf_render_page",
      "pdf_capture_region",
      "pdf_text_lines",
      "pdf_search",
      "pdf_ocr_page",
    ].includes(command)
  )
    return (await engine.invoke(command, args)) as T;
  if (command === "pdf_close") engine.close(String(args.docId));
  const result = await host.invoke(command, args);
  if (command === "pdf_close") clearDocumentHistoryRecovery(String(args.docId));
  if (
    [
      "pdf_delete_pages",
      "pdf_paste_pages",
      "pdf_duplicate_pages",
      "pdf_rotate_pages",
      "pdf_restore_snapshot",
      "pdf_rollback_restore",
      "pdf_save_document",
    ].includes(command)
  )
    engine.close(String(args.docId));
  return result as T;
}
export const open = (options: DialogOptions = {}) => bridge().open(options);
export const save = (options: DialogOptions = {}) => bridge().save(options);
export const ask = (message: string, options: DialogOptions = {}) =>
  bridge().ask(message, options);
export const confirmUnsaved = (message: string) =>
  bridge().confirmUnsaved(message);
export const readFile = (path: string) => bridge().readFile(path);
export const writeFile = (path: string, bytes: Uint8Array) =>
  bridge().writeFile(path, bytes);
export async function listen<T>(
  name: string,
  handler: (event: { payload: T }) => void,
) {
  return await bridge().listen(name, (payload) =>
    handler({ payload: payload as T }),
  );
}
export const filePath = (file: File) => bridge().filePath(file);
export function onFileDrop(
  handler: (payload: {
    paths: string[];
    position: { x: number; y: number };
  }) => void,
) {
  const over = (event: DragEvent) => event.preventDefault();
  const drop = (event: DragEvent) => {
    event.preventDefault();
    const paths = Array.from(event.dataTransfer?.files ?? [])
      .map(filePath)
      .filter(Boolean);
    if (paths.length)
      handler({ paths, position: { x: event.clientX, y: event.clientY } });
  };
  window.addEventListener("dragover", over);
  window.addEventListener("drop", drop);
  return () => {
    window.removeEventListener("dragover", over);
    window.removeEventListener("drop", drop);
  };
}
