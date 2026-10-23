import { Show, createSignal } from "solid-js";
import { documentStore, fileNameFromPath } from "../state/document";
import "./help.css";

interface Pending {
  docId: string;
  retry: boolean;
  resolve: (value: string | null) => void;
}

const [pending, setPending] = createSignal<Pending | null>(null);
const queue: Pending[] = [];

function showNext() {
  setPending(queue.shift() ?? null);
}

/** PasswordProvider for pdfEngine().setPasswordProvider (C4). */
export function requestPassword(docId: string, retry: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    const entry = { docId, retry, resolve };
    if (pending()) queue.push(entry);
    else setPending(entry);
  });
}

export function PasswordDialog() {
  let input: HTMLInputElement | undefined;
  const fileName = () => {
    const p = pending();
    const tab = p && documentStore.tabs.find((t) => t.docId === p.docId);
    return tab ? fileNameFromPath(tab.path) : null;
  };
  const finish = (value: string | null) => {
    const p = pending();
    if (!p) return;
    p.resolve(value);
    showNext();
  };
  return (
    <Show when={pending()}>
      {(p) => (
        <div class="help-backdrop">
          <form
            class="help-dialog password-dialog"
            role="dialog"
            aria-modal="true"
            aria-label="암호 입력"
            onSubmit={(e) => { e.preventDefault(); finish(input?.value ?? ""); }}
            onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); finish(null); } }}
          >
            <h2>암호로 보호된 문서</h2>
            <Show when={fileName()}>{(name) => <p class="password-file">{name()}</p>}</Show>
            <Show when={p().retry}><p class="password-error" role="alert">암호가 틀렸습니다</p></Show>
            <input ref={(el) => { input = el; queueMicrotask(() => el.focus()); }} type="password" aria-label="암호" autocomplete="off" />
            <div class="help-actions">
              <button type="button" class="toolbar-btn" onClick={() => finish(null)}>취소</button>
              <button type="submit" class="toolbar-btn">확인</button>
            </div>
          </form>
        </div>
      )}
    </Show>
  );
}
