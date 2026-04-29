# rustpdf

Lightweight cross-platform PDF viewer (macOS / Windows) with annotation tools.

Inspired by macOS Preview and ALZip Viewer.

## Stack

- **Tauri 2.x** — native shell, ~Rust backend + WebView UI
- **pdfium-render** — Chromium's PDF engine via Rust bindings
- **Solid.js + Vite + TypeScript** — frontend
- **LRU bitmap cache + virtual scroll** — handles 100MB PDFs without buckling

## First-time setup

```bash
npm install
npm run setup-pdfium     # downloads libpdfium for your host into src-tauri/lib
```

Required toolchains:

- Node 18+
- Rust stable (`rustup install stable`)
- macOS: Xcode Command Line Tools (`xcode-select --install`)
- Windows: Microsoft C++ Build Tools + WebView2 (preinstalled on Win11)

## Develop

```bash
npm run tauri dev
```

## Bundle

```bash
npm run tauri build      # produces .dmg (macOS) or .msi (Windows)
```

The pdfium dynamic library in `src-tauri/lib/` is bundled into the resulting
app via the Tauri resources mechanism (configure in `tauri.conf.json` if you
target additional platforms).

## Architecture

```
src/                  Solid frontend
  viewer/             virtualized page list, per-page canvas
  annotations/        SVG + canvas overlays for shapes/text/pen/markup
  toolbar/            top toolbar (zoom, pages, rotation, tools)
  ipc/                typed wrappers around Tauri commands
  state/              Solid stores (document, annotations)

src-tauri/src/        Rust backend
  pdf/document.rs     open document, extract page metadata
  pdf/render.rs       render a single page to PNG bytes
  pdf/cache.rs        LRU bitmap cache with byte budget (default 256MB)
  pdf/mod.rs          pdfium binding loader
  ipc.rs              shared application state (registry + cache)
  lib.rs              Tauri commands + plugin wiring
```

### Memory & performance

- **Page virtualization**: only pages near the viewport are rendered; others
  are placeholders. (`src/viewer/PdfViewer.tsx`)
- **LRU cache**: rendered PNG bytes are keyed by
  `(doc, page, scale_bucket, rotation)`; oldest are evicted when total
  bytes exceed the budget. (`src-tauri/src/pdf/cache.rs`)
- **Zoom bucketing**: zoom levels are quantized to 25% steps so small
  changes don't trigger a re-render. (`src/viewer/PageCanvas.tsx`)
- **Zero-copy bitmaps**: PNG bytes flow through Tauri IPC and are decoded
  via `createImageBitmap` directly into a `<canvas>`.

## Roadmap

See `/Users/jb/.claude/plans/cuddly-conjuring-marble.md` for the full plan.
Implemented so far: project skeleton, PDF render core, virtualized scroll,
LRU cache, basic toolbar (open / page / zoom / rotate).
