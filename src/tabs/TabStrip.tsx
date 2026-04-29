import { For } from "solid-js";
import { X } from "lucide-solid";
import {
  documentStore,
  fileNameFromPath,
  setActiveTab,
} from "../state/document";
import { closeTab, requestOpenPdfDialog } from "../ipc/pdf";
import "./tabs.css";

export function TabStrip() {
  return (
    <div class="tab-strip" role="tablist">
      <For each={documentStore.tabs}>
        {(tab) => {
          const dirty = () => tab.annotations.dirty || tab.pageDirty;
          const active = () => documentStore.activeTabId === tab.tabId;
          return (
            <div
              role="tab"
              tabindex="0"
              class="tab-item"
              classList={{ active: active(), dirty: dirty() }}
              title={tab.path}
              onPointerDown={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  void closeTab(tab.tabId);
                  return;
                }
                if (event.button === 0) {
                  setActiveTab(tab.tabId);
                }
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
                {fileNameFromPath(tab.path)}
              </span>
              <button
                type="button"
                class="tab-close"
                title="탭 닫기 (Cmd+W)"
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
        title="새 PDF 열기 (Cmd+O)"
        onClick={requestOpenPdfDialog}
      >
        +
      </button>
    </div>
  );
}
