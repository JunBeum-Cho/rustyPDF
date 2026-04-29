#!/usr/bin/env node
// Downloads the pdfium dynamic library for the current host into src-tauri/lib/
// Source: https://github.com/bblanchon/pdfium-binaries
//
// Run once after cloning:  node scripts/setup-pdfium.mjs

import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const LIB_DIR = join(ROOT, "src-tauri", "lib");

const RELEASE = process.env.PDFIUM_RELEASE || "chromium/7811";

const platforms = {
  "darwin-arm64": {
    asset: "pdfium-mac-arm64.tgz",
    libName: "libpdfium.dylib",
    libPath: "lib/libpdfium.dylib",
  },
  "darwin-x64": {
    asset: "pdfium-mac-x64.tgz",
    libName: "libpdfium.dylib",
    libPath: "lib/libpdfium.dylib",
  },
  "win32-x64": {
    asset: "pdfium-win-x64.tgz",
    libName: "pdfium.dll",
    libPath: "bin/pdfium.dll",
  },
  "win32-arm64": {
    asset: "pdfium-win-arm64.tgz",
    libName: "pdfium.dll",
    libPath: "bin/pdfium.dll",
  },
  "linux-x64": {
    asset: "pdfium-linux-x64.tgz",
    libName: "libpdfium.so",
    libPath: "lib/libpdfium.so",
  },
};

const key = `${process.platform}-${process.arch}`;
const target = platforms[key];
if (!target) {
  console.error(`unsupported platform: ${key}`);
  process.exit(1);
}

mkdirSync(LIB_DIR, { recursive: true });

const finalPath = join(LIB_DIR, target.libName);
if (existsSync(finalPath) && !process.env.FORCE) {
  console.log(`pdfium already present: ${finalPath}`);
  console.log("(set FORCE=1 to re-download)");
  process.exit(0);
}

const url = `https://github.com/bblanchon/pdfium-binaries/releases/download/${RELEASE}/${target.asset}`;
console.log(`downloading ${url}`);

const tmpTgz = join(LIB_DIR, `_${target.asset}`);
const res = await fetch(url);
if (!res.ok) {
  console.error(`download failed: HTTP ${res.status}`);
  process.exit(1);
}
await pipeline(res.body, createWriteStream(tmpTgz));

console.log(`extracting ${target.libPath}`);
await execFileP("tar", ["-xzf", tmpTgz, "-C", LIB_DIR, target.libPath]);

// Tarball stores it under e.g. `lib/libpdfium.dylib` — flatten it.
const { renameSync, rmdirSync, rmSync } = await import("node:fs");
const extractedFull = join(LIB_DIR, target.libPath);
if (extractedFull !== finalPath) {
  renameSync(extractedFull, finalPath);
  // best effort: remove the empty parent directory left behind
  try {
    rmdirSync(join(LIB_DIR, target.libPath.split("/")[0]));
  } catch {
    /* not empty or missing */
  }
}
rmSync(tmpTgz);

console.log(`pdfium installed: ${finalPath}`);
