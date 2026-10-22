export const COMMANDS = new Set([
  "pdf_open",
  "pdf_close",
  "pdf_document_bytes",
  "pdf_create_from_images",
  "pdf_delete_pages",
  "pdf_copy_pages",
  "pdf_paste_pages",
  "pdf_duplicate_pages",
  "pdf_rotate_pages",
  "pdf_restore_snapshot",
  "pdf_rollback_restore",
  "pdf_accept_restore",
  "pdf_save_document",
  "annotations_load",
  "annotations_save",
  "export_annotated_pdf",
  "pdf_ocr_page",
  "pdf_ocr_lines",
  "pdf_ocr_status",
  "pdf_ocr_flush",
  "initial_open_paths",
  "request_app_exit",
  "note_recent_document",
  "set_dock_recents",
  "clipboard_write_png",
]);
export const EVENTS = new Set(["open-pdfs", "app-close-requested"]);
export function assertCommand(command: unknown): asserts command is string {
  if (typeof command !== "string" || !COMMANDS.has(command))
    throw new Error("Unknown desktop command");
}
export function assertSender(actual: string, expected: string) {
  if (actual !== expected) throw new Error("Foreign desktop sender");
}
export function takeOpenPaths(queue: string[]) {
  return [...new Set(queue.splice(0))];
}
