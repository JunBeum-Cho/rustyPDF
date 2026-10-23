import { For, Show, onMount } from "solid-js";
import { FolderOpen, Images, Combine, X } from "lucide-solid";
import { openImageImport } from "../images/importState";
import { addDocumentTab, openPdf, openPdfDialog } from "../ipc/pdf";
import { invoke, open } from "../platform/desktop";
import { emitToast } from "../capture/capture";
import {
  checkRecentPaths,
  missingRecents,
  recentFiles,
  removeRecentFile,
} from "./recentFiles";
// The welcome logo points at the same PNG that `npm run icon` regenerates
// for the OS-level app icon, so the in-app branding stays in sync with
// the taskbar / Dock icon without needing a separate asset.
import logoUrl from "../assets/logo.png";
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

const offerRemoval = (path: string, message: string) =>
  emitToast(message, "error", {
    actions: [{ label: "목록에서 제거", run: () => removeRecentFile(path) }],
  });

const openRecent = async (path: string) => {
  if (missingRecents().has(path)) {
    offerRemoval(path, "파일을 찾을 수 없습니다.");
    return;
  }
  // openPdf already toasts the failure; only add the removal action quietly.
  if (!(await openPdf(path))) {
    emitToast("목록에서 제거할 수 있습니다.", "info", {
      actions: [{ label: "목록에서 제거", run: () => removeRecentFile(path) }],
    });
  }
};

const mergePdfs = async () => {
  let selected: string | string[] | null;
  try {
    selected = await open({
      multiple: true,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
  } catch (error) {
    emitToast(`파일 선택 창을 열 수 없습니다: ${String(error)}`, "error");
    return;
  }
  if (selected === null) return;
  const paths = Array.isArray(selected) ? selected : [selected];
  if (paths.length < 2) {
    emitToast("두 개 이상 선택해 주세요");
    return;
  }
  try {
    const payload = await invoke("pdf_merge_files", { paths, name: "합친 문서" });
    await addDocumentTab(payload as never, { unsaved: true });
  } catch (error) {
    emitToast(`PDF를 합칠 수 없습니다: ${String(error)}`, "error");
  }
};

export function Welcome() {
  onMount(() => void checkRecentPaths());
  return (
    <div class="welcome">
      <div class="welcome-inner">
        <div class="welcome-brand">
          <div class="welcome-logo">
            <img src={logoUrl} alt="RustyPDF" />
          </div>
          <h1>RustyPDF</h1>
          <p class="welcome-tagline">PDF 보기 · 주석 · 편집</p>
        </div>

        <div class="welcome-actions">
          <button
            type="button"
            class="welcome-primary"
            onClick={() => void openPdfDialog()}
          >
            <FolderOpen size={18} />
            <span>PDF 열기</span>
          </button>
          <button type="button" class="welcome-secondary" onClick={() => openImageImport()}>
            <Images size={18} />
            <span>이미지 → PDF 변환</span>
          </button>
          <button type="button" class="welcome-secondary" onClick={() => void mergePdfs()}>
            <Combine size={18} />
            <span>PDF 합치기</span>
          </button>
        </div>

        <Show
          when={recentFiles.entries.length > 0}
          fallback={
            <p class="welcome-hint">
              창에 PDF 또는 PNG · JPG 이미지를 끌어다 놓으세요.
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
                      classList={{ missing: missingRecents().has(entry.path) }}
                      title={entry.path}
                      onClick={() => void openRecent(entry.path)}
                    >
                      <div class="welcome-recents-item-main">
                        <span class="welcome-recents-name">{entry.name}</span>
                        <span class="welcome-recents-path">{dirOf(entry.path)}</span>
                      </div>
                      <Show
                        when={missingRecents().has(entry.path)}
                        fallback={
                          <span class="welcome-recents-time">
                            {formatRelative(entry.openedAt)}
                          </span>
                        }
                      >
                        <span class="welcome-recents-tag">파일 없음</span>
                      </Show>
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
