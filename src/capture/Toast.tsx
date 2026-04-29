import { For, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { setToastEmitter } from "./capture";
import "./toast.css";

interface ToastEntry {
  id: number;
  message: string;
  kind: "info" | "error";
}

const [toasts, setToasts] = createStore<{ list: ToastEntry[] }>({ list: [] });
let nextId = 1;

const dismiss = (id: number) => {
  setToasts("list", (prev) => prev.filter((t) => t.id !== id));
};

const push = (message: string, kind: "info" | "error" = "info") => {
  const id = nextId++;
  setToasts("list", (prev) => [...prev, { id, message, kind }]);
  // Auto-dismiss after a few seconds — error toasts linger a bit longer.
  window.setTimeout(() => dismiss(id), kind === "error" ? 5000 : 2200);
};

export function ToastHost() {
  onMount(() => {
    setToastEmitter((event) => push(event.message, event.kind ?? "info"));
  });
  return (
    <div class="toast-host" aria-live="polite">
      <For each={toasts.list}>
        {(toast) => (
          <div
            class="toast-item"
            classList={{ error: toast.kind === "error" }}
            onClick={() => dismiss(toast.id)}
          >
            {toast.message}
          </div>
        )}
      </For>
    </div>
  );
}
