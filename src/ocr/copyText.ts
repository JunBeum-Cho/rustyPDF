/** PDF/OCR text is transparent and positioned for selection, not for pasting. */
export function copyPageText(event: ClipboardEvent) {
  if (event.defaultPrevented || !event.clipboardData) return;
  const target = event.target as Element | null;
  if (target?.closest?.('input, textarea, [contenteditable]:not([contenteditable="false"])')) return;
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) return;
  const isPageText = (node: Node | null) => {
    const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
    return Boolean(element?.closest(".ocr-text-layer"));
  };
  if (!isPageText(selection.anchorNode) || !isPageText(selection.focusNode)) return;
  const text = selection.toString();
  if (!text) return;
  event.clipboardData.clearData();
  event.clipboardData.setData("text/plain", text);
  event.preventDefault();
}
