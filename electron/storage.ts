import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  open,
  rename,
  unlink,
  readFile,
  stat,
  realpath,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";
export const fingerprint = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export async function exists(path: string) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
export async function readJson(path: string): Promise<any> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}
export async function atomicWrite(path: string, bytes: Uint8Array | string) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${randomUUID()}.tmp`;
  let handle;
  try {
    const mode = await stat(path)
      .then((info) => info.mode & 0o777)
      .catch(() => 0o600);
    handle = await open(temp, "wx", mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temp, path);
    try {
      const dir = await open(dirname(path), "r");
      await dir.sync();
      await dir.close();
    } catch {
      /* Directory fsync is unavailable on Windows. */
    }
  } finally {
    await handle?.close();
    await unlink(temp).catch(() => {});
  }
}
export async function sameFile(a: string, b: string) {
  if (a.startsWith("unsaved://") || b.startsWith("unsaved://")) return a === b;
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)]);
    if (sa.dev === sb.dev && sa.ino === sb.ino) return true;
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return resolve(a) === resolve(b);
  }
}
