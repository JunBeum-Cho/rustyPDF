import { Worker } from "node:worker_threads";
export class ServiceWorker {
  private worker: Worker;
  private next = 0;
  private failure: Error | undefined;
  private pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  constructor(path: string, workerData: unknown) {
    this.worker = new Worker(path, { workerData });
    this.worker.on("message", ({ id, result, error }) => {
      const item = this.pending.get(id);
      if (!item) return;
      this.pending.delete(id);
      error ? item.reject(new Error(error)) : item.resolve(result);
    });
    this.worker.on("error", (error) =>
      this.fail(error instanceof Error ? error : new Error(String(error))),
    );
    this.worker.on("exit", () => this.fail(new Error("PDF worker exited")));
  }
  private fail(error: Error) {
    this.failure = error;
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
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
      this.fail(new Error("PDF worker disposed"));
      await this.worker.terminate();
    }
  }
}
