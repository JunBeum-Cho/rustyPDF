import { createHash } from "node:crypto";
import path from "node:path";

const IMAGE_PATH_COMMANDS: Record<string, string> = {
  pdf_create_from_images: "paths",
  pdf_merge_files: "paths",
};

function normalize(file: unknown): string {
  if (typeof file !== "string" || !path.isAbsolute(file))
    throw new Error("Invalid path");
  const resolved = path.resolve(file);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function draftFileName(file: string): string {
  return createHash("sha256").update(file).digest("hex") + ".json";
}

export class PathGrants {
  private readable = new Set<string>();
  private writable = new Set<string>();

  grant(file: string, options: { write?: boolean } = {}) {
    const key = normalize(file);
    this.readable.add(key);
    if (options.write) this.writable.add(key);
  }
  has(file: unknown): boolean {
    try {
      return this.readable.has(normalize(file));
    } catch {
      return false;
    }
  }
  canWrite(file: unknown): boolean {
    try {
      return this.writable.has(normalize(file));
    } catch {
      return false;
    }
  }
  private require(file: unknown) {
    if (!this.has(file)) throw new Error("허용되지 않은 파일 경로입니다.");
  }
  checkCommand(
    command: string,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    if (command === "pdf_open") {
      const target = normalize(args.path);
      if (!target.toLowerCase().endsWith(".pdf"))
        throw new Error("PDF 파일만 열 수 있습니다.");
      return args;
    }
    if (command === "pdf_save_document") {
      if (!this.canWrite(args.targetPath))
        return { ...args, requireCurrentPath: true };
      return args;
    }
    if (command === "export_annotated_pdf") {
      if (!this.canWrite(args.targetPath))
        throw new Error("허용되지 않은 파일 경로입니다.");
      return args;
    }
    const listKey = IMAGE_PATH_COMMANDS[command];
    if (listKey) {
      const list = args[listKey];
      if (!Array.isArray(list)) throw new Error("Invalid arguments");
      for (const item of list) this.require(item);
      return args;
    }
    if (command === "pdf_insert_file") {
      this.require(args.path);
      return args;
    }
    return args;
  }
}

export function safeExternalUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("Invalid url");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Invalid url");
  }
  if (!["http:", "https:", "mailto:"].includes(parsed.protocol))
    throw new Error("허용되지 않은 링크입니다.");
  return parsed.href;
}
