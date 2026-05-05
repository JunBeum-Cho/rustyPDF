// icon.ts — regenerate Tauri app-icon variants from a single source PNG.
//
// Usage:
//   npm run icon                  # uses ./icon.png at the project root
//   npm run icon -- ./other.png   # explicit source path
//
// Tauri's CLI handles the actual variant generation (ico, icns, the
// 32 / 128 / 128@2x PNGs that `tauri.conf.json` references). All output
// lands in `src-tauri/icons/`, overwriting whatever's there.
//
// The source PNG should be square and at least 1024x1024; anything smaller
// looks mushy on high-DPI Windows taskbars and Retina macOS docks.

import { existsSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const sourceArg: string = process.argv[2] ?? "icon.png";
const SOURCE: string = resolve(sourceArg);

if (!existsSync(SOURCE) || !statSync(SOURCE).isFile()) {
  console.error(`source icon not found: ${SOURCE}`);
  console.error(
    "place a square PNG (>= 1024x1024) at the project root as icon.png, " +
      "or pass an explicit path: npm run icon -- /path/to/foo.png",
  );
  process.exit(1);
}

console.log(`generating tauri icon variants from ${SOURCE}`);

// Talk to the locally-installed Tauri CLI directly rather than going
// through `npx tauri ...`. npx routes via `npm exec`, which gets flaky
// when node_modules has been touched by a mix of package managers
// (npm + bun + yarn) — it can fail with "could not determine executable
// to run" even when the binary is sitting in node_modules/.bin/. A
// straight invocation of the .bin shim sidesteps the whole resolution
// layer.
const isWindows: boolean = process.platform === "win32";
// Different package managers use different shim formats. npm creates a
// `tauri.cmd` script, bun emits a real `tauri.exe`, yarn uses both.
// Probe a few names and use whichever is present. Direct .exe doesn't
// need shell:true; .cmd does.
const candidates: string[] = isWindows
  ? ["tauri.exe", "tauri.cmd", "tauri.bat", "tauri"]
  : ["tauri"];

let cmd: string | null = null;
let needsShell = false;
for (const name of candidates) {
  const path = resolve("node_modules", ".bin", name);
  if (existsSync(path)) {
    cmd = path;
    needsShell = isWindows && !name.endsWith(".exe");
    break;
  }
}

let args: string[];
if (cmd === null) {
  console.warn(
    "local tauri CLI not found in node_modules/.bin — falling back to npx",
  );
  cmd = isWindows ? "npx.cmd" : "npx";
  needsShell = isWindows;
  args = ["tauri", "icon", SOURCE];
} else {
  args = ["icon", SOURCE];
}

const result = spawnSync(cmd, args, {
  stdio: "inherit",
  shell: needsShell,
});

if (result.error) {
  console.error(`failed to invoke tauri CLI: ${result.error.message}`);
  process.exit(1);
}

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log("done. icons written to src-tauri/icons/");
console.log("rebuild with: npm run tauri:dev  (or npm run build:windows)");
