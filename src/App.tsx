import { Show, onMount } from "solid-js";
import { Toolbar } from "./toolbar/Toolbar";
import { TabStrip } from "./tabs/TabStrip";
import { PdfViewer } from "./viewer/PdfViewer";
import { SearchPanel } from "./search/SearchPanel";
import { Welcome } from "./welcome/Welcome";
import { ToastHost } from "./capture/Toast";
import { activeTab, documentStore } from "./state/document";
import { installKeyboardShortcuts } from "./keyboard";
import { installAnnotationAutosave } from "./annotations/persistence";
import { installFileOpenHandlers, setImageDropHandler } from "./ipc/opening";
import { installCloseGuard } from "./ipc/closeGuard";
import { installPageClipboardShortcuts } from "./viewer/pageClipboard";
import { installRecentFilesTracking } from "./welcome/recentFiles";
import { handleImageDrop } from "./viewer/imageDrop";

export default function App() {
  installKeyboardShortcuts();
  installAnnotationAutosave();
  installFileOpenHandlers();
  installCloseGuard();
  installPageClipboardShortcuts();
  installRecentFilesTracking();
  onMount(() => {
    setImageDropHandler(handleImageDrop);
  });
  return (
    <div class="app">
      <Toolbar />
      <Show when={documentStore.tabs.length > 0}>
        <TabStrip />
      </Show>
      <main class="app-main">
        <Show when={activeTab()} fallback={<Welcome />}>
          <PdfViewer />
        </Show>
        <SearchPanel />
      </main>
      <ToastHost />
    </div>
  );
}
