import { build } from "esbuild";
import { common, worker } from "./electron-build-options.mjs";
await build({
  ...common,
  entryPoints: ["electron/main.ts", "electron/preload.ts"],
});
await build({
  ...common,
  ...worker,
  entryPoints: ["electron/worker.ts"],
});
