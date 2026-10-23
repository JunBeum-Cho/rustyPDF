import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { activeTab, updateActiveTab } from "../state/document";
import { setUiStore, uiStore } from "../state/ui";
import type { OcrLine, SearchHit } from "../ipc/pdf";
import { invoke } from "../platform/desktop";
import { pdfEngine } from "../platform/pdf-engine";
import "./search.css";
import {
  buildOcrText,
  buildPageText,
  itemRect,
  mergeSearchHits,
  nextSearchIndex,
  searchPageText,
  type PageText,
} from "./model";
import { setActiveSearchMatch } from "./store";
import { ocrState } from "../ocr/ocr";

const DEBOUNCE_MS = 220;
const BATCH_PAGES = 20;

/** Per (doc, revision) caches: native page text and the OCR lines. */
interface DocCache {
  key: string;
  native: Map<number, Promise<PageText>>;
  ocrKey: string;
  ocr: Promise<Record<string, OcrLine[]>> | null;
}
let cache: DocCache | null = null;

function docCache(docId: string, revision: number): DocCache {
  const key = `${docId}:${revision}`;
  if (cache?.key !== key) cache = { key, native: new Map(), ocrKey: "", ocr: null };
  return cache;
}

/** One pdf_ocr_all_lines per revision (refetched only when OCR grew). */
function ocrLines(docId: string, revision: number, doneCount: number) {
  const c = docCache(docId, revision);
  const ocrKey = String(doneCount);
  if (!c.ocr || c.ocrKey !== ocrKey) {
    c.ocrKey = ocrKey;
    c.ocr = invoke<Record<string, OcrLine[]>>("pdf_ocr_all_lines", {
      docId,
      expectedRevision: revision,
    });
  }
  return c.ocr;
}

function nativeText(docId: string, revision: number, pageIndex: number) {
  const c = docCache(docId, revision);
  let found = c.native.get(pageIndex);
  if (!found) {
    found = (async () => {
      const pdf = await pdfEngine().getDocument(docId, revision);
      const page = await pdf.getPage(pageIndex + 1);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items.flatMap((item) =>
        "str" in item
          ? [{ str: item.str, hasEOL: item.hasEOL, rect: itemRect(item, viewport) }]
          : [],
      );
      return buildPageText(items);
    })();
    found.catch(() => c.native.delete(pageIndex));
    c.native.set(pageIndex, found);
  }
  return found;
}

async function searchOnePage(
  docId: string,
  revision: number,
  pageIndex: number,
  query: string,
  ocr: Record<string, OcrLine[]>,
): Promise<SearchHit[]> {
  const native = await nativeText(docId, revision, pageIndex);
  if (native.text.trim()) return searchPageText(pageIndex, native, query);
  const lines = ocr[String(pageIndex)];
  return lines?.length ? searchPageText(pageIndex, buildOcrText(lines), query) : [];
}

export function SearchPanel() {
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [activeIndex, setActiveIndex] = createSignal(-1);

  let inputEl: HTMLInputElement | undefined;
  /** Bumped by every new query/tab/revision; stale loops stop. */
  let generation = 0;
  let pendingNavigation = false;
  /** OCR pages already searched in the current generation. */
  let ocrSeen = new Set<number>();
  let fullSearchRunning = false;

  createEffect(
    on(
      () => uiStore.searchOpen,
      (open) => {
        if (open) queueMicrotask(() => inputEl?.focus());
      },
    ),
  );

  // Reset when active tab changes
  createEffect(
    on(
      () => activeTab()?.tabId,
      () => {
        setQuery("");
        setHits([]);
        setError(null);
        setActiveIndex(-1);
      },
    ),
  );

  const stillCurrent = (mine: number, tabId: string, revision: number) => {
    const live = activeTab();
    return mine === generation && live?.tabId === tabId && live.revision === revision;
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const mine = ++generation;
    pendingNavigation = false;
    setError(null);
    setActiveSearchMatch(null);
    setHits([]);
    setActiveIndex(-1);
    ocrSeen = new Set();
    fullSearchRunning = false;
    const q = query().trim();
    const tab = activeTab();
    const open = uiStore.searchOpen;
    if (timer) clearTimeout(timer);
    onCleanup(() => {
      if (timer) clearTimeout(timer);
    });
    if (!open || !tab || q.length === 0) {
      setLoading(false);
      return;
    }
    setLoading(true);
    const { docId, tabId, revision, pageCount } = tab;
    timer = setTimeout(async () => {
      fullSearchRunning = true;
      try {
        const done = new Set(ocrState.byDoc[docId]?.done ?? []);
        const ocr = await ocrLines(docId, revision, done.size);
        let acc: SearchHit[] = [];
        for (let from = 0; from < pageCount; from += BATCH_PAGES) {
          const pages = Array.from(
            { length: Math.min(BATCH_PAGES, pageCount - from) },
            (_, i) => from + i,
          );
          const results = await Promise.all(
            pages.map((p) => searchOnePage(docId, revision, p, q, ocr)),
          );
          if (!stillCurrent(mine, tabId, revision)) return;
          acc = mergeSearchHits(acc, results.flat(), pages, -1).hits;
          setHits(acc);
          if (pendingNavigation && acc.length) {
            pendingNavigation = false;
            jumpTo(0);
          }
        }
        ocrSeen = done;
        setError(null);
      } catch (e) {
        if (!stillCurrent(mine, tabId, revision)) return;
        setError(e instanceof Error ? e.message : String(e));
        setHits([]);
      } finally {
        if (stillCurrent(mine, tabId, revision)) {
          fullSearchRunning = false;
          setLoading(false);
          void searchNewOcrPages();
        }
      }
    }, DEBOUNCE_MS);
  });

  /** OCR progress: search only newly recognised pages and merge. */
  async function searchNewOcrPages() {
    const tab = activeTab();
    const q = query().trim();
    if (!tab || !q || !uiStore.searchOpen || fullSearchRunning) return;
    const done = ocrState.byDoc[tab.docId]?.done;
    if (!done || ocrState.byDoc[tab.docId].revision !== tab.revision) return;
    const fresh = [...done].filter((p) => !ocrSeen.has(p) && p < tab.pageCount);
    if (fresh.length === 0) return;
    const mine = generation;
    const { docId, tabId, revision } = tab;
    const seen = new Set(done);
    try {
      const ocr = await ocrLines(docId, revision, done.size);
      const results = await Promise.all(
        fresh.map((p) => searchOnePage(docId, revision, p, q, ocr)),
      );
      if (!stillCurrent(mine, tabId, revision)) return;
      const merged = mergeSearchHits(hits(), results.flat(), fresh, activeIndex());
      ocrSeen = seen;
      setHits(merged.hits);
      setActiveIndex(merged.activeIndex);
    } catch {
      /* the next OCR progress event retries */
    }
  }

  createEffect(
    on(
      () => {
        const tab = activeTab();
        return tab ? ocrState.byDoc[tab.docId]?.done : undefined;
      },
      () => void searchNewOcrPages(),
      { defer: true },
    ),
  );

  onCleanup(() => setActiveSearchMatch(null));

  function jumpTo(i: number) {
    const list = hits();
    if (list.length === 0) return;
    const idx = ((i % list.length) + list.length) % list.length;
    const tab = activeTab();
    if (!tab) return;
    setActiveIndex(idx);
    setActiveSearchMatch({
      tabId: tab.tabId,
      revision: tab.revision,
      query: query(),
      hit: list[idx],
      navigation: Date.now(),
    });
    // Clamp: a hit can outlive the page it pointed at (e.g. pages deleted
    // after the search ran), and an out-of-range currentPage blanks the view.
    const max = Math.max(0, tab.pageCount - 1);
    const page = Math.max(0, Math.min(max, list[idx].page));
    updateActiveTab((t) => {
      t.navigationVersion = (t.navigationVersion ?? 0) + 1;
      t.currentPage = page;
    });
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setUiStore("searchOpen", false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (loading()) pendingNavigation = true;
      else
        jumpTo(
          nextSearchIndex(activeIndex(), e.shiftKey ? -1 : 1, hits().length),
        );
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      jumpTo(nextSearchIndex(activeIndex(), 1, hits().length));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      jumpTo(nextSearchIndex(activeIndex(), -1, hits().length));
    }
  }

  return (
    <Show when={uiStore.searchOpen}>
      <aside class="search-panel">
        <header class="search-header">
          <input
            ref={inputEl}
            class="search-input"
            type="text"
            placeholder="검색…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={onKey}
          />
          <button
            class="search-close"
            title="닫기 (Esc)"
            onClick={() => setUiStore("searchOpen", false)}
          >
            ✕
          </button>
        </header>

        <div class="search-meta">
          <Show when={loading()}>검색 중…</Show>
          <Show when={!loading() && hits().length > 0}>
            {Math.max(0, activeIndex() + 1)} / {hits().length}
          </Show>
          <Show when={!loading() && query() && hits().length === 0 && !error()}>
            결과 없음
          </Show>
          <Show when={error()}>
            <span class="search-error">오류: {error()}</span>
          </Show>
        </div>

        <ul class="search-results">
          <For each={hits()}>
            {(hit, i) => (
              <li
                class="search-hit"
                classList={{ active: i() === activeIndex() }}
                onClick={() => jumpTo(i())}
              >
                <span class="search-hit-page">p.{hit.page + 1}</span>
                <span class="search-hit-snippet">{hit.snippet}</span>
              </li>
            )}
          </For>
        </ul>
      </aside>
    </Show>
  );
}
