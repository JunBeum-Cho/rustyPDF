import { Show, createEffect, createMemo } from "solid-js";
import { ScanText } from "lucide-solid";
import { activeTab } from "../state/document";
import { ocrState, refreshOcrStatus, runOcrAll } from "./ocr";
import "./ocr.css";

export function OcrButton() {
  const tab = () => activeTab();

  // Re-fetch status whenever the active tab changes — covers reopening a
  // doc that already has an OCR sidecar so progress reflects the cached
  // pages without re-running anything.
  createEffect(() => {
    const t = tab();
    if (t) void refreshOcrStatus(t.docId, t.revision, t.pageCount);
  });

  const progress = createMemo(() => {
    const t = tab();
    if (!t) return null;
    const s = ocrState.byDoc[t.docId];
    if (!s || s.revision !== t.revision) return null;
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
    const { tabId, docId, revision, pageCount } = t;
    await refreshOcrStatus(docId, revision, pageCount);
    const live = tab();
    if (
      !live ||
      live.tabId !== tabId ||
      live.docId !== docId ||
      live.revision !== revision
    ) return;
    await runOcrAll(docId, revision, pageCount);
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
