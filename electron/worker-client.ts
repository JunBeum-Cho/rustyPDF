import { Worker } from "node:worker_threads";

const CRASH_MESSAGE = "PDF 엔진이 중단되었습니다";
const MAX_RESTARTS = 3;
const RESTART_WINDOW_MS = 60_000;

export interface PdfWorkerHooks {
  onEvent?(name: string, payload: unknown): void;
  onRestart?(error: Error): void;
}

export class PdfWorkerClient {
  private worker: Worker;
  private next = 0;
  private failure: Error | undefined;
  private closing = false;
  private restarts: number[] = [];
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  constructor(
    private readonly path: string,
    private readonly workerData: unknown,
    private readonly hooks: PdfWorkerHooks = {},
  ) {
    this.worker = this.spawn();
  }
  private spawn(): Worker {
    const worker = new Worker(this.path, { workerData: this.workerData });
    let handled = false;
    const crashed = () => {
      if (handled) return;
      handled = true;
      if (worker === this.worker) this.crash();
    };
    worker.on("message", (message) => {
      if (worker !== this.worker || !message) return;
      if (typeof message.event === "string") {
        try {
          this.hooks.onEvent?.(message.event, message.payload);
        } catch {
          // a faulty listener must not break the reply path
        }
        return;
      }
      const item = this.pending.get(message.id);
      if (!item) return;
      this.pending.delete(message.id);
      message.error
        ? item.reject(new Error(message.error))
        : item.resolve(message.result);
    });
    worker.on("error", crashed);
    worker.on("exit", crashed);
    return worker;
  }
  private rejectAll(error: Error) {
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }
  private crash() {
    const error = new Error(CRASH_MESSAGE);
    this.rejectAll(error);
    if (this.closing) {
      this.failure = error;
      return;
    }
    const now = Date.now();
    this.restarts = this.restarts.filter((t) => now - t < RESTART_WINDOW_MS);
    if (this.restarts.length >= MAX_RESTARTS) {
      this.failure = error;
      return;
    }
    this.restarts.push(now);
    this.worker = this.spawn();
    try {
      this.hooks.onRestart?.(error);
    } catch {
      // ignore listener failure
    }
  }
  invoke(command: string, args: Record<string, unknown> = {}) {
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.next;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage({ id, command, args });
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async dispose() {
    this.closing = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        this.invoke("__dispose"),
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("PDF worker shutdown timed out")),
            5000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      this.failure = new Error("PDF worker disposed");
      this.rejectAll(this.failure);
      await this.worker.terminate();
    }
  }
}
