import { For, Show } from "solid-js";
import { FileText, FolderOpen, X } from "lucide-solid";
import { requestOpenPdfDialog, openPdf } from "../ipc/pdf";
import { recentFiles, removeRecentFile } from "./recentFiles";
import "./welcome.css";

const formatRelative = (iso: string): string => {
  const date = new Date(iso);
  const diffMs = Date.now() - date.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return "방금 전";
  if (min < 60) return `${min}분 전`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}시간 전`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}일 전`;
  return date.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
};

const dirOf = (path: string): string => {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join("/") || "/";
};

export function Welcome() {
  return (
    <div class="welcome">
      <div class="welcome-inner">
        <div class="welcome-brand">
          <div class="welcome-logo">
            <FileText size={36} strokeWidth={1.4} />
          </div>
          <h1>rustpdf</h1>
          <p class="welcome-tagline">가벼운 PDF 뷰어</p>
        </div>

        <div class="welcome-actions">
          <button
            type="button"
            class="welcome-primary"
            onClick={requestOpenPdfDialog}
          >
            <FolderOpen size={18} />
            <span>PDF 열기</span>
          </button>
        </div>

        <Show
          when={recentFiles.entries.length > 0}
          fallback={
            <p class="welcome-hint">
              파일을 열거나, 창에 PDF를 끌어다 놓으세요.
            </p>
          }
        >
          <section class="welcome-recents" aria-label="최근 파일">
            <header class="welcome-recents-header">
              <h2>최근 파일</h2>
            </header>
            <ul class="welcome-recents-list">
              <For each={recentFiles.entries}>
                {(entry) => (
                  <li>
                    <button
                      type="button"
                      class="welcome-recents-item"
                      title={entry.path}
                      onClick={() => void openPdf(entry.path)}
                    >
                      <div class="welcome-recents-item-main">
                        <span class="welcome-recents-name">{entry.name}</span>
                        <span class="welcome-recents-path">{dirOf(entry.path)}</span>
                      </div>
                      <span class="welcome-recents-time">
                        {formatRelative(entry.openedAt)}
                      </span>
                    </button>
                    <button
                      type="button"
                      class="welcome-recents-remove"
                      title="목록에서 제거"
                      onClick={(event) => {
                        event.stopPropagation();
                        removeRecentFile(entry.path);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </section>
        </Show>
      </div>
    </div>
  );
}
