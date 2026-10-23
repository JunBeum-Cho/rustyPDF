import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
} from "solid-js";
import { ScanText } from "lucide-solid";
import { activeTab } from "../state/document";
import {
  cancelOcr,
  includeOcrOnSave,
  setIncludeOcrOnSave,
  ocrState,
  refreshOcrStatus,
  runOcrAll,
  runOcrPage,
} from "./ocr";
import "./ocr.css";

export function OcrButton() {
  const [menuOpen, setMenuOpen] = createSignal(false);
  const [preparing, setPreparing] = createSignal(false);
  const [stopped, setStopped] = createSignal(false);
  let request = 0;
  let anchor!: HTMLDivElement;
  const placePopover = (popover: HTMLDivElement) => {
    const place = () => {
      if (!popover.isConnected) return;
      const bounds = anchor.getBoundingClientRect();
      const width = popover.getBoundingClientRect().width;
      const viewport = document.documentElement.clientWidth;
      const left = Math.max(8, Math.min(bounds.right - width, viewport - width - 8));
      popover.style.left = `${left - bounds.left}px`;
    };
    queueMicrotask(place);
    const observer = new ResizeObserver(place);
    observer.observe(anchor);
    observer.observe(document.documentElement);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    onCleanup(() => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    });
  };
  const tab = () => activeTab();
  createEffect(
    on(
      () => {
        const t = tab();
        return t
          ? ([t.tabId, t.docId, t.revision, t.pageCount] as const)
          : null;
      },
      (deps) => {
        request++;
        setPreparing(false);
        setStopped(false);
        setMenuOpen(false);
        if (deps) void refreshOcrStatus(deps[1], deps[2], deps[3]);
      },
    ),
  );
  const progress = createMemo(() => {
    const t = tab();
    if (!t) return null;
    const state = ocrState.byDoc[t.docId];
    return state?.revision === t.revision ? state : null;
  });
  const busy = () =>
    preparing() ||
    progress()?.current != null ||
    progress()?.waiting === true ||
    (progress()?.queued.size ?? 0) > 0;
  async function start(all = false, retryPage?: number) {
    const t = tab();
    if (!t || busy()) return;
    const token = ++request;
    const { tabId, docId, revision, pageCount, currentPage } = t;
    setMenuOpen(false);
    setStopped(false);
    setPreparing(true);
    try {
      await refreshOcrStatus(docId, revision, pageCount);
      const live = tab();
      if (
        token !== request ||
        live?.tabId !== tabId ||
        live.revision !== revision
      )
        return;
      setPreparing(false);
      if (all) await runOcrAll(docId, revision, pageCount);
      else
        await runOcrPage(docId, revision, pageCount, retryPage ?? currentPage);
    } finally {
      if (token === request) setPreparing(false);
    }
  }
  function stop() {
    request++;
    setPreparing(false);
    setStopped(true);
    const t = tab();
    if (t) cancelOcr(t.docId);
  }
  return (
    <Show when={tab()}>
      <div
        ref={anchor}
        style={{
          position: "relative",
          display: "inline-flex",
          gap: "2px",
          "align-items": "center",
        }}
      >
        <button
          type="button"
          class="toolbar-btn ocr-btn"
          classList={{ busy: busy() }}
          disabled={busy()}
          onClick={() => void start()}
          title="현재 페이지 텍스트 인식 (OCR)"
        >
          <ScanText size={16} />
          <span class="ocr-progress-label">
            {progress()?.waiting
              ? `OCR 대기 중`
              : busy()
              ? `OCR ${progress()?.done.size ?? 0}/${progress()?.total ?? tab()!.pageCount}`
              : `OCR${progress()?.done.size ? ` ${progress()!.done.size}/${progress()!.total}` : ""}`}
          </span>
        </button>
        <Show
          when={busy()}
          fallback={
            <button
              type="button"
              class="toolbar-btn"
              aria-label="OCR 범위와 오류"
              aria-expanded={menuOpen()}
              onClick={() => setMenuOpen(!menuOpen())}
            >
              ▾
            </button>
          }
        >
          <button
            type="button"
            class="toolbar-btn"
            onClick={stop}
            title="다음 페이지 인식을 중단합니다. 진행 중인 페이지 처리는 끝날 수 있습니다."
          >
            중지
          </button>
        </Show>
        <Show
          when={
            menuOpen() ||
            stopped() ||
            (progress()?.skipped ?? 0) > 0 ||
            Object.keys(progress()?.failures ?? {}).length > 0
          }
        >
          <div
            ref={placePopover}
            class="ocr-popover"
            role="group"
            aria-label="텍스트 인식 옵션"
            style={{
              position: "absolute",
              top: "100%",
              "z-index": 100,
              padding: "10px",
              background: "var(--surface)",
              color: "var(--text)",
              border: "1px solid var(--border)",
              "border-radius": "8px",
              "box-shadow": "0 4px 16px #0002",
            }}
          >
            <Show when={menuOpen()}>
              <label class="ocr-option">
                <input
                  type="checkbox"
                  checked={includeOcrOnSave()}
                  onChange={(e) =>
                    setIncludeOcrOnSave(e.currentTarget.checked)
                  }
                />
                저장할 때 인식한 텍스트 포함(검색 가능한 PDF)
              </label>
              <button
                type="button"
                class="toolbar-btn"
                disabled={busy()}
                onClick={() => void start(true)}
              >
                문서 전체 텍스트 인식
              </button>
            </Show>
            <Show when={(progress()?.skipped ?? 0) > 0}>
              <p role="status">텍스트 있음 {progress()!.skipped}쪽 건너뜀</p>
            </Show>
            <Show when={stopped()}>
              <p role="status">
                중지했습니다. 진행 중인 페이지 처리는 끝날 수 있습니다. 완료된
                결과는 유지됩니다.
              </p>
              <button
                type="button"
                class="toolbar-btn"
                onClick={() => setStopped(false)}
              >
                닫기
              </button>
            </Show>
            <For each={Object.entries(progress()?.failures ?? {})}>
              {([page, message]) => (
                <div role="status">
                  p.{Number(page) + 1}: {message}
                  <button
                    type="button"
                    class="toolbar-btn"
                    disabled={busy()}
                    onClick={() => void start(false, Number(page))}
                  >
                    다시 시도
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
