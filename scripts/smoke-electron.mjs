import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const requested = process.argv[2];
const packaged = requested === "--packaged";
const nativeExecutable =
  process.platform === "darwin"
    ? `release/${process.arch === "arm64" ? "mac-arm64" : "mac"}/RustyPDF.app/Contents/MacOS/RustyPDF`
    : `release/${process.arch === "arm64" ? "win-arm64-unpacked" : "win-unpacked"}/RustyPDF.exe`;
const executable = packaged
  ? nativeExecutable
  : (requested ?? createRequire(import.meta.url)("electron"));
const child = spawn(executable, requested ? [] : ["."], {
  stdio: "inherit",
  env: { ...process.env, RUSTYPDF_SMOKE: "1" },
});
let timedOut = false;
const timeout = setTimeout(() => {
  timedOut = true;
  child.kill("SIGTERM");
}, 90000);
child.on("error", (error) => {
  clearTimeout(timeout);
  console.error(error);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  clearTimeout(timeout);
  process.exitCode = timedOut ? 1 : (code ?? 1);
});
