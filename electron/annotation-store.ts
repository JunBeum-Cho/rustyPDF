import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Annotation } from "../src/annotations/types.js";
import { exists, fingerprint, readJson } from "./storage.js";

/** Read-only loader for pre-D1 sidecar files. It never writes anything. */
export function aliasName(path: string) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(path)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `${hash.toString(16).padStart(16, "0")}.notes.json`;
}
const validKey = (key: unknown): key is string =>
  typeof key === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(key);
export interface LegacyAnnotations {
  annotations: Annotation[];
  message: string;
}
const MESSAGE = "이전 버전 주석을 불러왔습니다. 저장하면 PDF 안에 함께 저장됩니다.";
const found = (sidecar: any): LegacyAnnotations | null =>
  Array.isArray(sidecar?.annotations) && sidecar.annotations.length
    ? { annotations: sidecar.annotations, message: MESSAGE }
    : null;

async function fromRoot(root: string, path: string, hash: string) {
  const alias = await readJson(join(root, aliasName(path)));
  if (alias) {
    if (!alias.pdfFingerprint && Array.isArray(alias.annotations))
      return found(alias);
    if (alias.pdfFingerprint === hash) {
      let stable = validKey(alias.documentKey)
        ? await readJson(
            join(root, "documents", hash, `${alias.documentKey}.notes.json`),
          )
        : null;
      if (!stable || stable.pdfFingerprint !== hash) stable = alias;
      if (stable.sourcePath === path || !(await exists(stable.sourcePath)))
        return found(stable);
    }
  }
  const directory = join(root, "documents", hash);
  const files = await readdir(directory).catch(() => []);
  const candidates = (
    await Promise.all(
      files
        .filter((f) => f.endsWith(".notes.json"))
        .map((f) => readJson(join(directory, f))),
    )
  ).filter(
    (d) =>
      d?.pdfFingerprint === hash &&
      validKey(d.documentKey) &&
      Array.isArray(d.annotations),
  );
  const exact = candidates.filter((d) => d.sourcePath === path);
  if (exact.length === 1) return found(exact[0]);
  const moved = [];
  for (const c of candidates)
    if (
      typeof c.sourcePath === "string" &&
      c.sourcePath !== path &&
      !(await exists(c.sourcePath))
    )
      moved.push(c);
  if (moved.length === 1) return found(moved[0]);
  // Identical copies are never linked automatically.
  return null;
}
async function adjacentNotes(path: string, hash: string) {
  const adjacent = await readJson(`${path}.notes.json`);
  if (adjacent && Array.isArray(adjacent.annotations))
    if (!adjacent.pdfFingerprint || adjacent.pdfFingerprint === hash)
      return found(adjacent);
  return null;
}

/** Look through every root (current first) for old-format annotations. */
export async function loadLegacy(
  path: string,
  bytes: Uint8Array,
  roots: string[] = [],
): Promise<LegacyAnnotations | null> {
  const hash = fingerprint(bytes);
  for (const root of roots) {
    const result = await fromRoot(root, path, hash).catch(() => null);
    if (result) return result;
  }
  return adjacentNotes(path, hash);
}
