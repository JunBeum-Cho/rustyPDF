# RustyPDF

RustyPDF is a local PDF editor for macOS and Windows. The Solid interface uses PDF.js for viewing, text selection, search and capture. Electron runs PDF editing, annotation storage, export and Korean/English OCR in a separate Node worker.

## Development

Install **Node.js 22.13 or newer**, then run:

```sh
npm ci
npm run dev
```

The postinstall script downloads the Electron 45 binary after a clean install. Node 20 cannot run the supported Electron build tools. On machines with an older system Node, use `npx node@22` to run the scripts.

```sh
npm test
npm run build
npm run smoke:electron
npm run pack
```

`npm run build` prepares offline resources, typechecks the renderer, builds Vite assets and bundles the main process, sandboxed CommonJS preload and PDF service worker. The generated resources include PDF.js workers, cMaps, standard fonts and WASM; English and Korean Tesseract models and worker/core; and the licensed Noto Sans CJK Korean export font. No OCR network download is required at runtime.

## Packaging

```sh
npm run build:mac
npm run build:windows
```

The builder configuration targets macOS arm64/x64 and Windows x64/arm64. Outputs are written to `release/`. Local builds are unsigned; production signing and notarization require the distributor's credentials. CI runs tests, builds, an actual Electron startup smoke and an unpacked package on native macOS and Windows runners. macOS cannot establish Windows runtime behavior.

PDF files retain their editable annotations in sidecars. Normal Save updates the PDF document and its annotation metadata; annotated export creates a flattened PDF. Existing metadata in the previous `com.rustpdf.viewer` application data location remains discoverable for migration. Keep that directory when upgrading.

The renderer has Node disabled and uses a sandboxed preload with a command/event allowlist. All document parsing, editing, disk persistence and OCR run outside Electron's main process. The legacy Rust/Tauri sources, build cache and PDFium setup tools have been removed; development and packaging use only the Electron codebase.
