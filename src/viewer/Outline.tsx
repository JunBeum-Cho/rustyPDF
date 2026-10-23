import { For, Show, createEffect, createSignal, on } from "solid-js";
import { pdfEngine } from "../platform/pdf-engine";
import { activeTab } from "../state/document";
import { navigateToPage } from "./navigation";
import { flattenOutline, resolveDestToPageIndex, type OutlineNode } from "./pdfLinks";

export function Outline() {
  const [nodes, setNodes] = createSignal<OutlineNode[] | null>(null);
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());
  let doc: any = null;

  createEffect(
    on(
      () => [activeTab()?.docId, activeTab()?.revision] as const,
      async ([docId, revision]) => {
        setNodes(null);
        setExpanded(new Set<string>());
        if (!docId || revision === undefined) return;
        try {
          const d = await pdfEngine().getDocument(docId, revision);
          const outline = await d.getOutline();
          if (activeTab()?.docId !== docId || activeTab()?.revision !== revision) return;
          doc = d;
          setNodes((outline ?? []) as OutlineNode[]);
        } catch {
          setNodes([]);
        }
      },
    ),
  );

  const rows = () => flattenOutline(nodes() ?? [], expanded());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const go = async (dest: unknown) => {
    if (!doc) return;
    const idx = await resolveDestToPageIndex(doc, dest);
    if (idx !== null) navigateToPage(idx);
  };

  return (
    <div class="outline-panel" role="tree" aria-label="목차">
      <Show when={nodes() !== null} fallback={<p class="outline-empty">불러오는 중…</p>}>
        <Show when={rows().length > 0} fallback={<p class="outline-empty">목차가 없는 문서입니다</p>}>
          <For each={rows()}>
            {(row) => (
              <div
                class="outline-row"
                role="treeitem"
                aria-expanded={row.hasChildren ? row.expanded : undefined}
                style={{ "padding-left": `${row.depth * 14 + 4}px` }}
              >
                <button
                  type="button"
                  class="outline-toggle"
                  aria-label={row.expanded ? "접기" : "펼치기"}
                  style={{ visibility: row.hasChildren ? "visible" : "hidden" }}
                  onClick={() => toggle(row.key)}
                >
                  {row.expanded ? "▾" : "▸"}
                </button>
                <button type="button" class="outline-title" onClick={() => void go(row.dest)}>
                  {row.title}
                </button>
              </div>
            )}
          </For>
        </Show>
      </Show>
    </div>
  );
}
