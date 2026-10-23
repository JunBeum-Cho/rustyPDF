import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";

interface Entry {
  path: string;
  fingerprint: string;
  mtimeMs: number;
  size: number;
  missing: boolean;
  busy: boolean;
}

export class DiskWatcher {
  private entries = new Map<string, Entry>();
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private onChange: (id: string) => void,
    private intervalMs = 2000,
  ) {}

  watch(id: string, path: string, fingerprint: string) {
    if (path.startsWith("unsaved://")) {
      this.entries.delete(id);
      return;
    }
    const entry: Entry = {
      path,
      fingerprint,
      mtimeMs: -1,
      size: -1,
      missing: false,
      busy: false,
    };
    this.entries.set(id, entry);
    void stat(path)
      .then((info) => {
        if (this.entries.get(id) === entry && entry.mtimeMs === -1) {
          entry.mtimeMs = info.mtimeMs;
          entry.size = info.size;
        }
      })
      .catch(() => {});
    if (!this.timer) {
      this.timer = setInterval(() => void this.poll(), this.intervalMs);
      this.timer.unref();
    }
  }

  update(id: string, path: string, fingerprint: string) {
    this.watch(id, path, fingerprint);
  }

  unwatch(id: string) {
    this.entries.delete(id);
    this.stopIfIdle();
  }

  dispose() {
    this.entries.clear();
    this.stopIfIdle();
  }

  private stopIfIdle() {
    if (this.entries.size === 0 && this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private async poll() {
    await Promise.all(
      [...this.entries].map(([id, entry]) => this.check(id, entry)),
    );
  }

  private async check(id: string, entry: Entry) {
    if (entry.busy) return;
    entry.busy = true;
    try {
      let info;
      try {
        info = await stat(entry.path);
      } catch {
        if (this.entries.get(id) === entry && !entry.missing) {
          entry.missing = true;
          this.onChange(id);
        }
        return;
      }
      entry.missing = false;
      if (entry.mtimeMs === -1) {
        entry.mtimeMs = info.mtimeMs;
        entry.size = info.size;
        return;
      }
      if (info.mtimeMs === entry.mtimeMs && info.size === entry.size) return;
      const hash = createHash("sha256")
        .update(await readFile(entry.path))
        .digest("hex");
      if (this.entries.get(id) !== entry) return;
      entry.mtimeMs = info.mtimeMs;
      entry.size = info.size;
      if (hash !== entry.fingerprint) {
        entry.fingerprint = hash;
        this.onChange(id);
      }
    } catch {
      /* transient read failure: retry on the next tick */
    } finally {
      entry.busy = false;
    }
  }
}
