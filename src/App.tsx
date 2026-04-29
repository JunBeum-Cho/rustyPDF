import { Show } from "solid-js";
import { Toolbar } from "./toolbar/Toolbar";
import { PdfViewer } from "./viewer/PdfViewer";
import { SearchPanel } from "./search/SearchPanel";
import { documentStore } from "./state/document";
import { requestOpenPdfDialog } from "./ipc/pdf";
import { installKeyboardShortcuts } from "./keyboard";
import { installAnnotationAutosave } from "./annotations/persistence";
import { installFileOpenHandlers } from "./ipc/opening";
import { installCloseGuard } from "./ipc/closeGuard";

export default function App() {
  installKeyboardShortcuts();
  installAnnotationAutosave();
  installFileOpenHandlers();
  installCloseGuard();
  return (
    <div class="app">
      <Toolbar />
      <main class="app-main">
        <Show
          when={documentStore.doc}
          fallback={
            <div class="empty">
              <h1>rustpdf</h1>
              <p>가벼운 PDF 뷰어. PDF를 열어 시작하세요.</p>
              <button onClick={requestOpenPdfDialog}>PDF 열기</button>
              <p class="hint">또는 창에 PDF 파일을 끌어다 놓으세요.</p>
            </div>
          }
        >
          <PdfViewer />
        </Show>
        <SearchPanel />
      </main>
    </div>
  );
}
