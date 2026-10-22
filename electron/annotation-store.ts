import { randomUUID } from "node:crypto";
import { readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { atomicWrite, exists, fingerprint, readJson } from "./storage.js";
export function aliasName(path: string) {
  let hash = 0xcbf29ce484222325n;
  for (const byte of Buffer.from(path)) {
    hash = BigInt.asUintN(64, (hash ^ BigInt(byte)) * 0x100000001b3n);
  }
  return `${hash.toString(16).padStart(16, "0")}.notes.json`;
}
const validKey = (key: unknown): key is string =>
  typeof key === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(key);
export class AnnotationStore {
  constructor(
    private root: string,
    private legacyRoots: string[] = [],
  ) {}
  enrich(path: string, bytes: Uint8Array, data: any) {
    if (!data || typeof data !== "object" || !Array.isArray(data.annotations))
      throw new Error("Invalid annotation sidecar");
    return {
      ...data,
      version: 2,
      sourcePath: path,
      pdfFingerprint: fingerprint(bytes),
      documentKey: validKey(data.documentKey) ? data.documentKey : randomUUID(),
    };
  }
  private stable(root: string, data: any) {
    return join(
      root,
      "documents",
      data.pdfFingerprint,
      `${data.documentKey}.notes.json`,
    );
  }
  async stage(path: string, bytes: Uint8Array, data: any) {
    const sidecar = this.enrich(path, bytes, data);
    const target = this.stable(this.root, sidecar);
    const current = await readJson(target);
    if (
      current?.sourcePath &&
      current.sourcePath !== path &&
      (await exists(current.sourcePath))
    )
      throw new Error("Annotation store belongs to another existing PDF");
    await atomicWrite(target, JSON.stringify(sidecar));
    return sidecar;
  }
  async save(path: string, bytes: Uint8Array, data: any) {
    const sidecar = await this.stage(path, bytes, data);
    await atomicWrite(
      join(this.root, aliasName(path)),
      JSON.stringify(sidecar),
    );
    await unlink(`${path}.notes.json`).catch(() => {});
    return sidecar;
  }
  async load(path: string, bytes: Uint8Array) {
    for (const root of [this.root, ...this.legacyRoots]) {
      const result = await this.loadRoot(root, path, bytes);
      if (result.status !== "none") {
        if (root !== this.root && result.sidecar)
          await this.save(path, bytes, result.sidecar);
        return result;
      }
    }
    return { sidecar: null, status: "none", message: null };
  }
  private async loadRoot(root: string, path: string, bytes: Uint8Array) {
    const hash = fingerprint(bytes);
    const result = (
      sidecar: any,
      status: string,
      message: string | null = null,
    ) => ({ sidecar, status, message });
    const alias = await readJson(join(root, aliasName(path)));
    let mismatch = await exists(join(root, aliasName(path)));
    if (alias) {
      if (!alias.pdfFingerprint && Array.isArray(alias.annotations))
        return result(alias, "legacy", "기존 주석을 다음 저장 때 이전합니다.");
      if (alias.pdfFingerprint === hash) {
        let stable = validKey(alias.documentKey)
          ? await readJson(this.stable(root, alias))
          : null;
        if (!stable || stable.pdfFingerprint !== hash) stable = alias;
        if (stable.sourcePath === path || !(await exists(stable.sourcePath))) {
          const claimed = await this.stage(path, bytes, stable);
          return result(claimed, "exact");
        }
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
    if (exact.length === 1) {
      await atomicWrite(
        join(this.root, aliasName(path)),
        JSON.stringify(exact[0]),
      ).catch(() => {});
      return result(exact[0], "exact");
    }
    const moved = [];
    for (const c of candidates)
      if (
        typeof c.sourcePath === "string" &&
        c.sourcePath !== path &&
        !(await exists(c.sourcePath))
      )
        moved.push(c);
    if (moved.length === 1) {
      const recovered = await this.stage(path, bytes, moved[0]);
      if (root !== this.root)
        await atomicWrite(
          this.stable(root, recovered),
          JSON.stringify(recovered),
        );
      await atomicWrite(
        join(this.root, aliasName(path)),
        JSON.stringify(recovered),
      ).catch(() => {});
      return result(
        recovered,
        "recovered",
        "이동된 PDF의 주석을 복구했습니다.",
      );
    }
    if (candidates.length)
      return result(
        null,
        "ambiguous",
        "동일한 PDF 복사본의 주석은 자동 연결하지 않았습니다.",
      );
    const adjacent = await readJson(`${path}.notes.json`);
    if (adjacent) {
      if (adjacent.pdfFingerprint && adjacent.pdfFingerprint !== hash)
        return result(null, "mismatch", "PDF와 주석의 지문이 다릅니다.");
      if (Array.isArray(adjacent.annotations))
        return result(
          adjacent,
          "legacy",
          "기존 주석을 다음 저장 때 이전합니다.",
        );
    }
    return result(
      null,
      mismatch ? "mismatch" : "none",
      mismatch ? "PDF와 주석의 지문이 다릅니다." : null,
    );
  }
}
