import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { activeTab, updateActiveTab } from "../state/document";
import { setUiStore, uiStore } from "../state/ui";
import { searchPdf, type SearchHit } from "../ipc/pdf";
import "./search.css";

const DEBOUNCE_MS = 220;

export function SearchPanel() {
  const [query, setQuery] = createSignal("");
  const [hits, setHits] = createSignal<SearchHit[]>([]);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [activeIndex, setActiveIndex] = createSignal(0);

  let inputEl: HTMLInputElement | undefined;
  let searchSequence = 0;

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
        setActiveIndex(0);
      },
    ),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const sequence = ++searchSequence;
    const q = query().trim();
    const tab = activeTab();
    if (timer) clearTimeout(timer);
    onCleanup(() => {
      if (timer) clearTimeout(timer);
    });
    if (!tab || q.length === 0) {
      setHits([]);
      setError(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    const docId = tab.docId;
    const tabId = tab.tabId;
    const revision = tab.revision;
    timer = setTimeout(async () => {
      try {
        const result = await searchPdf(docId, revision, q);
        // The user may have switched tabs while the search was in flight —
        // or edited/requeried this document. Never let an older response
        // paint its page indices over a newer generation or query.
        const live = activeTab();
        if (
          sequence !== searchSequence ||
          live?.tabId !== tabId ||
          live.revision !== revision
        ) return;
        setHits(result);
        setActiveIndex(0);
        setError(null);
      } catch (e) {
        const live = activeTab();
        if (
          sequence !== searchSequence ||
          live?.tabId !== tabId ||
          live.revision !== revision
        ) return;
        setError(e instanceof Error ? e.message : String(e));
        setHits([]);
      } finally {
        const live = activeTab();
        if (
          sequence === searchSequence &&
          live?.tabId === tabId &&
          live.revision === revision
        ) setLoading(false);
      }
    }, DEBOUNCE_MS);
  });

  function jumpTo(i: number) {
    const list = hits();
    if (list.length === 0) return;
    const idx = ((i % list.length) + list.length) % list.length;
    setActiveIndex(idx);
    const tab = activeTab();
    if (!tab) return;
    // Clamp: a hit can outlive the page it pointed at (e.g. pages deleted
    // after the search ran), and an out-of-range currentPage blanks the view.
    const max = Math.max(0, tab.pageCount - 1);
    const page = Math.max(0, Math.min(max, list[idx].page));
    updateActiveTab((t) => { t.currentPage = page; });
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      setUiStore("searchOpen", false);
    } else if (e.key === "Enter") {
      e.preventDefault();
      jumpTo(activeIndex() + (e.shiftKey ? -1 : 1));
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      jumpTo(activeIndex() + 1);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      jumpTo(activeIndex() - 1);
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
            {activeIndex() + 1} / {hits().length}
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
