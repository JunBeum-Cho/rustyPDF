// Shared esbuild options for the Electron bundles; tests reuse them so they
// exercise the same CJS output and external-module interop as the app.
export const common = {
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
export const worker = {
  define: { "import.meta.url": "__bundleUrl" },
  banner: {
    js: "const __bundleUrl = require('node:url').pathToFileURL(__filename).href;",
  },
};
