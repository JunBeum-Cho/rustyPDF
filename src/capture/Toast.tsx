import { For, onMount } from "solid-js";
import { createStore } from "solid-js/store";
import { setToastEmitter, type ToastAction, type ToastEvent } from "./capture";
import "./toast.css";

interface ToastEntry {
  id: number;
  message: string;
  kind: "info" | "error";
  actions?: ToastAction[];
}

const [toasts, setToasts] = createStore<{ list: ToastEntry[] }>({ list: [] });
let nextId = 1;

const dismiss = (id: number) => {
  setToasts("list", (prev) => prev.filter((t) => t.id !== id));
};

const push = (event: ToastEvent) => {
  const id = nextId++;
  const kind = event.kind ?? "info";
  setToasts("list", (prev) => [
    ...prev,
    { id, message: event.message, kind, actions: event.actions },
  ]);
  const timeoutMs =
    event.timeoutMs === undefined ? (kind === "error" ? 5000 : 2200) : event.timeoutMs;
  if (timeoutMs !== null) {
    window.setTimeout(() => dismiss(id), timeoutMs);
  }
};

const runAction = async (
  event: MouseEvent,
  toast: ToastEntry,
  action: ToastAction,
) => {
  event.stopPropagation();
  try {
    await action.run();
    dismiss(toast.id);
  } catch (error) {
    console.error("toast action failed", error);
    dismiss(toast.id);
    push({
      message: error instanceof Error ? error.message : String(error),
      kind: "error",
    });
  }
};

export function ToastHost() {
  onMount(() => {
    setToastEmitter(push);
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
            <div class="toast-message">{toast.message}</div>
            <For each={toast.actions ?? []}>
              {(action) => (
                <button
                  type="button"
                  class="toast-action"
                  onClick={(event) => void runAction(event, toast, action)}
                >
                  {action.label}
                </button>
              )}
            </For>
          </div>
        )}
      </For>
    </div>
  );
}
