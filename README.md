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

## Features

- Annotations are stored inside the PDF itself (standard annotation objects), so other viewers can read them. Normal Save writes them in place; annotated export creates a flattened copy.
- Unsaved edits are kept as drafts and offered for recovery after a crash.
- Print, outline (bookmarks) navigation and form field filling.
- Page operations plus merge PDFs, extract pages and create a PDF from images.
- OCR (Korean/English) with an option to save the recognized text layer into the PDF.
- Encrypted PDFs open read-only.
- Disk changes to an open file are detected.

## Packaging

```sh
npm run build:mac
npm run build:windows
```

The builder configuration targets macOS arm64/x64 and Windows x64/arm64. Outputs are written to `release/`.

### Signing and notarization

Signing is driven only by environment variables; without them builds are unsigned.

- macOS: `CSC_LINK`, `CSC_KEY_PASSWORD`. Notarization runs only when `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD` and `APPLE_TEAM_ID` (or the `APPLE_API_KEY*` set) are present. Hardened runtime and `resources/entitlements.mac.plist` are always applied. Set `CSC_IDENTITY_AUTO_DISCOVERY=false` to force an unsigned build.
- Windows: `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`.

### Auto update

Off by default. A packaged app checks for updates only when `RUSTYPDF_UPDATE_URL` points to a generic update feed and the optional `electron-updater` module is installed. See the commented `publish` example in `electron-builder.yml`.

### CI

- `.github/workflows/ci.yml` (pull requests and branch pushes): `npm ci`, `npm test`, `npm run build`, `npm run smoke:electron` on macOS and Windows.
- `.github/workflows/release.yml` (tags `v*`): the same checks, then electron-builder for macOS (arm64, x64) and Windows (x64, arm64), a packaged smoke test and artifact upload. Signing secrets are optional.

macOS cannot establish Windows runtime behavior.

Existing metadata in the previous `com.rustpdf.viewer` application data location remains discoverable for migration. Keep that directory when upgrading.

The renderer has Node disabled and uses a sandboxed preload with a command/event allowlist. All document parsing, editing, disk persistence and OCR run outside Electron's main process.
