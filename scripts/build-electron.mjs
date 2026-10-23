import { build } from "esbuild";
const common = {
  outdir: "dist-electron",
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: [
    "electron",
    "tesseract.js",
    "@pdf-lib/fontkit",
    "pdf-lib",
    "exifr",
    "subset-font",
    "harfbuzzjs",
    "fontverter",
    "electron-updater",
  ],
  sourcemap: true,
};
await build({
  ...common,
  entryPoints: ["electron/main.ts", "electron/preload.ts"],
});
await build({
  ...common,
  entryPoints: ["electron/worker.ts"],
  define: { "import.meta.url": "__bundleUrl" },
  banner: {
    js: "const __bundleUrl = require('node:url').pathToFileURL(__filename).href;",
  },
});
