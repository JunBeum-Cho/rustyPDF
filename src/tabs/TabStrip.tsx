import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { X } from "lucide-solid";
import {
  documentStore,
  setActiveTab,
  setDocumentStore,
} from "../state/document";
import { closeTab, openPdfDialog } from "../ipc/pdf";
import { emitToast } from "../capture/capture";
import "./tabs.css";
import { shortcutLabel } from "../platform/shortcuts";
import {
  closeSequentially,
  moveTab,
  tabLabels,
  tabsToClose,
  type CloseMode,
} from "./tabOrder";

const isUnsavedTab = (tab: { path: string; isUnsaved?: boolean }) =>
  Boolean(tab.isUnsaved) || tab.path.startsWith("unsaved://");

export function TabStrip() {
  let strip: HTMLDivElement | undefined;
  const labels = () => tabLabels(documentStore.tabs);
  const [menu, setMenu] = createSignal<{ tabId: string; x: number; y: number } | null>(null);
  const [drag, setDrag] = createSignal<{ tabId: string; startX: number; active: boolean } | null>(null);

  createEffect(() => {
    const id = documentStore.activeTabId;
    if (!id || !strip) return;
    queueMicrotask(() => {
      const el = Array.from(strip!.querySelectorAll<HTMLElement>(".tab-item")).find(
        (node) => node.dataset.tabId === id,
      );
      el?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
    });
  });

  const closeMany = async (tabId: string, mode: CloseMode) => {
    const ids = tabsToClose(documentStore.tabs, tabId, mode);
    await closeSequentially(
      ids,
      (id) => closeTab(id),
      (id) => documentStore.tabs.some((tab) => tab.tabId === id),
    );
  };

  const copyPath = async (tabId: string) => {
    const tab = documentStore.tabs.find((item) => item.tabId === tabId);
    if (!tab || isUnsavedTab(tab)) return;
    try {
      await navigator.clipboard.writeText(tab.path);
      emitToast("경로를 복사했습니다");
    } catch {
      emitToast("경로를 복사할 수 없습니다", "error");
    }
  };

  const onMove = (event: PointerEvent) => {
    const d = drag();
    if (!d || !strip) return;
    if (!d.active && Math.abs(event.clientX - d.startX) < 5) return;
    if (!d.active) setDrag({ ...d, active: true });
    const items = Array.from(strip.querySelectorAll<HTMLElement>(".tab-item"));
    const from = documentStore.tabs.findIndex((tab) => tab.tabId === d.tabId);
    let to = from;
    items.forEach((node, index) => {
      const rect = node.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right) to = index;
    });
    if (to !== from) {
      const next = moveTab(documentStore.tabs.slice(), from, to);
      setDocumentStore("tabs", next);
    }
  };
  const endDrag = () => setDrag(null);
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", endDrag);
  window.addEventListener("pointercancel", endDrag);
  const dismiss = () => setMenu(null);
  window.addEventListener("pointerdown", dismiss);
  onCleanup(() => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", endDrag);
    window.removeEventListener("pointerdown", dismiss);
  });

  const menuTab = () => documentStore.tabs.find((tab) => tab.tabId === menu()?.tabId);
  const run = (fn: () => void | Promise<void>) => () => {
    setMenu(null);
    void fn();
  };

  return (
    <div
      class="tab-strip"
      role="tablist"
      ref={strip}
      onWheel={(event) => {
        if (!strip || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
        strip.scrollLeft += event.deltaY;
        event.preventDefault();
      }}
    >
      <For each={documentStore.tabs}>
        {(tab) => {
          const dirty = () => tab.annotations.dirty || tab.pageDirty || tab.formDirty;
          const active = () => documentStore.activeTabId === tab.tabId;
          return (
            <div
              role="tab"
              aria-selected={active()}
              tabindex="0"
              class="tab-item"
              data-tab-id={tab.tabId}
              classList={{
                active: active(),
                dirty: dirty(),
                dragging: drag()?.active === true && drag()?.tabId === tab.tabId,
              }}
              title={tab.path}
              onPointerDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  void closeTab(tab.tabId);
                  return;
                }
                if (event.button === 0) {
                  setActiveTab(tab.tabId);
                  setDrag({ tabId: tab.tabId, startX: event.clientX, active: false });
                }
              }}
              onContextMenu={(event) => {
                event.preventDefault();
                setActiveTab(tab.tabId);
                setMenu({ tabId: tab.tabId, x: event.clientX, y: event.clientY });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setActiveTab(tab.tabId);
                }
              }}
            >
              <span class="tab-label">
                {dirty() ? "● " : ""}
                {labels()[tab.tabId]}
              </span>
              <button
                type="button"
                class="tab-close"
                title={`탭 닫기 (${shortcutLabel("W")})`}
                aria-label="탭 닫기"
                onPointerDown={(event) => event.stopPropagation()}
                onClick={(event) => {
                  event.stopPropagation();
                  void closeTab(tab.tabId);
                }}
              >
                <X size={12} />
              </button>
            </div>
          );
        }}
      </For>
      <button
        type="button"
        class="tab-new"
        title={`새 PDF 열기 (${shortcutLabel("O")})`}
        onClick={() => void openPdfDialog()}
      >
        +
      </button>
      <Show when={menu()}>
        {(m) => (
          <div
            class="tab-menu"
            role="menu"
            style={{ left: `${m().x}px`, top: `${m().y}px` }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <button type="button" role="menuitem" onClick={run(() => closeMany(m().tabId, "self"))}>
              닫기
            </button>
            <button type="button" role="menuitem" onClick={run(() => closeMany(m().tabId, "others"))}>
              다른 탭 닫기
            </button>
            <button type="button" role="menuitem" onClick={run(() => closeMany(m().tabId, "right"))}>
              오른쪽 탭 닫기
            </button>
            <Show when={menuTab() && !isUnsavedTab(menuTab()!)}>
              <button type="button" role="menuitem" onClick={run(() => copyPath(m().tabId))}>
                경로 복사
              </button>
            </Show>
          </div>
        )}
      </Show>
    </div>
  );
}
