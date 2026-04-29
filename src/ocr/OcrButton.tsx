import { Show, createMemo, onMount } from "solid-js";
import { ScanText } from "lucide-solid";
import { activeTab } from "../state/document";
import { ocrState, refreshOcrStatus, runOcrAll } from "./ocr";
import "./ocr.css";

export function OcrButton() {
  const tab = () => activeTab();

  // Re-fetch status whenever the active tab changes — covers reopening a
  // doc that already has an OCR sidecar so progress reflects the cached
  // pages without re-running anything.
  onMount(() => {
    const t = tab();
    if (t) void refreshOcrStatus(t.docId, t.pageCount);
  });

  const progress = createMemo(() => {
    const t = tab();
    if (!t) return null;
    const s = ocrState.byDoc[t.docId];
    if (!s) return null;
    return {
      done: s.done.size,
      total: s.total,
      current: s.current,
      busy: s.current !== null,
    };
  });

  const handleClick = async () => {
    const t = tab();
    if (!t) return;
    if (progress()?.busy) return;
    await refreshOcrStatus(t.docId, t.pageCount);
    await runOcrAll(t.docId, t.pageCount);
  };

  return (
    <Show when={tab()}>
      <button
        type="button"
        class="toolbar-btn ocr-btn"
        classList={{ busy: progress()?.busy ?? false }}
        onClick={handleClick}
        title="텍스트 인식 (스캔 PDF에서 검색 가능하게)"
        disabled={progress()?.busy ?? false}
      >
        <ScanText size={16} />
        <Show when={progress() && progress()!.total > 0}>
          <span class="ocr-progress-label">
            <Show
              when={progress()!.busy}
              fallback={<>{progress()!.done > 0 ? `OCR ${progress()!.done}/${progress()!.total}` : "OCR"}</>}
            >
              {progress()!.done}/{progress()!.total} (p.{(progress()!.current ?? 0) + 1})
            </Show>
          </span>
        </Show>
      </button>
    </Show>
  );
}
