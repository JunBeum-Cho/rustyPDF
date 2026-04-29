import { createMemo } from "solid-js";
import {
  ArrowUpRight,
  Camera,
  Circle,
  Download,
  Highlighter,
  Minus,
  MousePointer2,
  PenLine,
  Redo2,
  Square,
  Type,
  Undo2,
} from "lucide-solid";
import type { JSX } from "solid-js";
import { exportAnnotatedPdfFile } from "../ipc/pdf";
import { activeTab } from "../state/document";
import {
  annotationStore,
  redoAnnotations,
  setAnnotationColor,
  setAnnotationUiColor,
  setAnnotationStrokeWidth,
  setAnnotationTool,
  undoAnnotations,
} from "./store";
import { TextFormatToolbar } from "./TextFormatToolbar";
import { getActiveEditor, setFontColor } from "./textFormat";
import type { AnnotationTool } from "./types";

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
  const canExport = createMemo(() => Boolean(activeTab()));

  return (
    <div class="annotation-toolbar" aria-label="annotation tools">
      <div class="annotation-tool-group">
        {tools.map(({ tool, label, icon }) => (
          <button
            type="button"
            classList={{ active: annotationStore.tool === tool }}
            onClick={() => setAnnotationTool(tool)}
            title={label}
          >
            {icon()}
          </button>
        ))}
      </div>
      <label class="annotation-color" title="색상">
        <input
          type="color"
          value={annotationStore.color}
          onInput={(event) => {
            const color = event.currentTarget.value;
            if (getActiveEditor()) {
              setAnnotationUiColor(color);
              setFontColor(color);
              return;
            }
            setAnnotationColor(color);
          }}
        />
      </label>
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
      <TextFormatToolbar />
      <button
        type="button"
        class="toolbar-btn icon-only"
        onClick={undoAnnotations}
        disabled={annotationStore.history.length === 0}
        title="실행 취소 (Ctrl+Z)"
      >
        <Undo2 size={ICON_SIZE} />
      </button>
      <button
        type="button"
        class="toolbar-btn icon-only"
        onClick={redoAnnotations}
        disabled={annotationStore.future.length === 0}
        title="다시 실행 (Ctrl+Shift+Z)"
      >
        <Redo2 size={ICON_SIZE} />
      </button>
      <button
        type="button"
        class="toolbar-btn"
        onClick={exportAnnotatedPdfFile}
        disabled={!canExport()}
        title="주석 포함 PDF 내보내기"
      >
        <Download size={ICON_SIZE} />
        <span>내보내기</span>
      </button>
      <span
        class="annotation-save-status"
        classList={{ error: annotationStore.saveStatus === "error" }}
      >
        {annotationStore.saveStatus === "saving"
          ? "저장 중"
          : annotationStore.saveStatus === "error"
            ? "저장 실패"
            : annotationStore.dirty
              ? "변경됨"
              : "저장됨"}
      </span>
    </div>
  );
}
