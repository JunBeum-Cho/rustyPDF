import { createMemo, createSignal } from "solid-js";
import {
  ArrowUpRight,
  Camera,
  Circle,
  Download,
  Highlighter,
  Minus,
  MousePointer2,
  PenLine,
  Signature,
  Redo2,
  Square,
  Type,
  Undo2,
  BringToFront,
  SendToBack,
  ChevronUp,
  ChevronDown,
} from "lucide-solid";
import type { JSX } from "solid-js";
import { exportAnnotatedPdfFile } from "../ipc/pdf";
import { activeTab } from "../state/document";
import {
  annotationStore,
  setAnnotationColor,
  setAnnotationUiColor,
  setAnnotationStrokeWidth,
  setAnnotationTool,
  bringToFront,
  sendToBack,
  bringForward,
  sendBackward,
  setAnnotationFillColor,
} from "./store";
import { SignatureDialog } from "./SignatureDialog";
import "./signature.css";
import { ColorPalette } from "./ColorPalette";
import { TextFormatToolbar } from "./TextFormatToolbar";
import { getActiveEditor, setFontColor } from "./textFormat";
import type { AnnotationTool } from "./types";

import { undoDocumentEdit, redoDocumentEdit, canUndoDocumentEdit, canRedoDocumentEdit } from "../viewer/documentHistory";
import { shortcutLabel } from "../platform/shortcuts";

const ICON_SIZE = 16;

const tools: Array<{ tool: AnnotationTool; label: string; icon: () => JSX.Element }> = [
  { tool: "select", label: "선택", icon: () => <MousePointer2 size={ICON_SIZE} /> },
  { tool: "text", label: "텍스트", icon: () => <Type size={ICON_SIZE} /> },
  { tool: "highlight", label: "형광펜", icon: () => <Highlighter size={ICON_SIZE} /> },
  { tool: "rect", label: "사각형", icon: () => <Square size={ICON_SIZE} /> },
  { tool: "ellipse", label: "원", icon: () => <Circle size={ICON_SIZE} /> },
  { tool: "line", label: "선", icon: () => <Minus size={ICON_SIZE} /> },
  { tool: "arrow", label: "화살표", icon: () => <ArrowUpRight size={ICON_SIZE} /> },
  { tool: "pen", label: "펜", icon: () => <PenLine size={ICON_SIZE} /> },
  { tool: "capture", label: "영역 캡처 (드래그 후 클립보드 복사)", icon: () => <Camera size={ICON_SIZE} /> },
];

export function AnnotationToolbar() {
  const [signatureOpen, setSignatureOpen] = createSignal(false);
  const readOnly = () => activeTab()?.readOnly ?? false;
  const canExport = createMemo(() => Boolean(activeTab()) && !readOnly());
  const statusLabel = () => {
    const tab = activeTab();
    if (tab?.readOnly) return "읽기 전용";
    if (tab?.isUnsaved) return "저장 전 문서";
    return annotationStore.dirty || tab?.pageDirty || tab?.formDirty ? "변경됨" : "저장됨";
  };
  const context = createMemo(() => {
    const annotations = activeTab()?.annotations;
    const text = annotations?.items.some(
      (item) => item.type === "text" &&
        (item.id === annotations.editingId || annotations.selectedIds.includes(item.id)),
    ) ?? false;
    return { text, layer: annotationStore.selectedIds.length === 1 };
  });
  const textSettings = () => context().text || annotationStore.tool === "text";
  const contextOpen = createMemo(() => context().text || context().layer);
  // Keep the last controls mounted while the menu fades out.
  const displayedContext = createMemo<{ text: boolean; layer: boolean }>(
    (previous) => contextOpen() ? context() : previous,
    { text: false, layer: false },
  );

  return (
    <div class="annotation-toolbar" aria-label="annotation tools">
      <div class="annotation-tool-group">
        {tools.map(({ tool, label, icon }) => (
          <button
            type="button"
            classList={{ active: annotationStore.tool === tool }}
            onClick={() => setAnnotationTool(tool)}
            title={`${label}${({ select: " (V)", text: " (T)", highlight: " (H)", pen: " (P)" } as Record<string, string>)[tool] ?? ""}`}
            aria-label={label}
            aria-pressed={annotationStore.tool === tool}
            disabled={readOnly() && tool !== "select"}
          >
            {icon()}
          </button>
        ))}
        <button
          type="button"
          onClick={() => setSignatureOpen(true)}
          disabled={readOnly() || !activeTab()}
          title="서명 추가"
          aria-label="서명"
        >
          <Signature size={ICON_SIZE} />
        </button>
      </div>
      <SignatureDialog open={signatureOpen()} onClose={() => setSignatureOpen(false)} />
      <ColorPalette label={textSettings() ? "글자색" : "그리기 색상"}
        value={textSettings() ? annotationStore.textColor : annotationStore.color}
        onChange={(color) => {
          if (getActiveEditor()) { setAnnotationUiColor(color); setFontColor(color); return; }
          setAnnotationColor(color);
        }} />
      <label class="annotation-checkbox" title="배경색 채우기" style={{ display: "inline-flex", "align-items": "center", gap: "4px", "font-size": "13px", "margin-left": "4px", cursor: "pointer", color: "var(--text-dim)" }}>
        <input
          type="checkbox"
          checked={annotationStore.fill !== "transparent"}
          onChange={(event) => {
            const checked = event.currentTarget.checked;
            setAnnotationFillColor(checked ? annotationStore.color : "transparent");
          }}
        />
        <span>배경 채우기</span>
      </label>
      <span style={{ "margin-left": "4px", visibility: annotationStore.fill === "transparent" ? "hidden" : "visible" }}>
        <ColorPalette label="배경색" disabled={annotationStore.fill === "transparent"}
          value={annotationStore.fill === "transparent" ? "#ffffff" : annotationStore.fill}
          onChange={setAnnotationFillColor} />
      </span>
      <label class="annotation-number" title="선 두께">
        <span>두께</span>
        <input
          type="number"
          min="1"
          max="18"
          value={annotationStore.strokeWidth}
          onInput={(event) => setAnnotationStrokeWidth(Number(event.currentTarget.value))}
        />
      </label>
      <div
        class="annotation-context-menu"
        classList={{ "is-open": contextOpen(), "has-text": displayedContext().text }}
        role="toolbar"
        aria-label="선택한 주석 편집"
        aria-hidden={!contextOpen()}
        inert={!contextOpen()}
      >
        <TextFormatToolbar />
        <div class="annotation-tool-group" hidden={!displayedContext().layer} title="정렬 (레이어 순서)">
          <button
            type="button"
            onClick={() => bringToFront(annotationStore.selectedIds[0])}
            title="맨 앞으로 가져오기"
          >
            <BringToFront size={ICON_SIZE} />
          </button>
          <button
            type="button"
            onClick={() => bringForward(annotationStore.selectedIds[0])}
            title="앞으로 가져오기"
          >
            <ChevronUp size={ICON_SIZE} />
          </button>
          <button
            type="button"
            onClick={() => sendBackward(annotationStore.selectedIds[0])}
            title="뒤로 보내기"
          >
            <ChevronDown size={ICON_SIZE} />
          </button>
          <button
            type="button"
            onClick={() => sendToBack(annotationStore.selectedIds[0])}
            title="맨 뒤로 보내기"
          >
            <SendToBack size={ICON_SIZE} />
          </button>
        </div>
      </div>
      <button
        type="button"
        class="toolbar-btn icon-only"
        onClick={() => void undoDocumentEdit()}
        disabled={!canUndoDocumentEdit()}
        title={`실행 취소 (${shortcutLabel("Z")})`}
      >
        <Undo2 size={ICON_SIZE} />
      </button>
      <button
        type="button"
        class="toolbar-btn icon-only"
        onClick={() => void redoDocumentEdit()}
        disabled={!canRedoDocumentEdit()}
        title={`다시 실행 (${shortcutLabel("Z", true)})`}
      >
        <Redo2 size={ICON_SIZE} />
      </button>
      <button
        type="button"
        class="toolbar-btn"
        onClick={exportAnnotatedPdfFile}
        disabled={!canExport()}
        title="주석은 PDF 안에 저장되어 다른 뷰어에서도 보입니다"
      >
        <Download size={ICON_SIZE} />
        <span>내보내기</span>
      </button>
      <span
        class="annotation-save-status"
        title="주석은 PDF 안에 저장되어 다른 뷰어에서도 보입니다"
      >
        {statusLabel()}
      </span>
    </div>
  );
}
