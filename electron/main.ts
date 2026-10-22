import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  clipboard,
  ClipboardItem,
  nativeImage,
  Menu,
} from "electron";
import { readFile, writeFile, mkdtemp, copyFile } from "node:fs/promises";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
if (process.env.RUSTYPDF_SMOKE)
  app.setPath(
    "userData",
    mkdtempSync(path.join(tmpdir(), "rustypdf-smoke-data-")),
  );
import { pathToFileURL } from "node:url";
import { ServiceWorker } from "./worker-client";
import { assertCommand, assertSender, takeOpenPaths } from "./protocol";
let smokePath: string | undefined;
let window: BrowserWindow | null = null;
let service: ServiceWorker;
let allowExit = false;
let quitting = false;
let subscribed = false;
const queue: string[] = [];
const root = path.resolve(__dirname, "..");
const dev = process.env.RUSTYPDF_DEV_URL;
const url = dev ?? pathToFileURL(path.join(root, "dist/index.html")).href;
function enqueue(paths: string[]) {
  queue.push(...paths.filter((p) => p.toLowerCase().endsWith(".pdf")));
  if (subscribed && window)
    window.webContents.send("open-pdfs", takeOpenPaths(queue));
}
app.on("open-file", (event, file) => {
  event.preventDefault();
  enqueue([file]);
});
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    enqueue(argv.filter((p) => path.isAbsolute(p)));
    window?.show();
    window?.focus();
  });
  app.whenReady().then(async () => {
    const assetsDir = app.isPackaged
      ? path.join(process.resourcesPath, "assets")
      : path.join(root, "resources/assets");
    const legacy =
      process.platform === "darwin"
        ? path.join(
            app.getPath("home"),
            "Library/Application Support/com.rustpdf.viewer",
          )
        : path.join(
            process.env.LOCALAPPDATA ?? app.getPath("appData"),
            "com.rustpdf.viewer",
          );
    service = new ServiceWorker(path.join(__dirname, "worker.cjs"), {
      dataDir: app.getPath("userData"),
      legacyDataDirs: [legacy],
      assetsDir,
    });
    const validate = (event: Electron.IpcMainInvokeEvent) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Foreign desktop sender");
      assertSender(event.senderFrame.url, url);
    };
    ipcMain.handle("desktop:command", async (event, command, args = {}) => {
      validate(event);
      assertCommand(command);
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("Invalid arguments");
      if (command === "initial_open_paths") {
        subscribed = true;
        return takeOpenPaths(queue);
      }
      if (command === "request_app_exit") {
        allowExit = true;
        app.quit();
        return;
      }
      if (command === "note_recent_document") {
        if (
          !process.env.RUSTYPDF_SMOKE &&
          typeof args.path === "string" &&
          path.isAbsolute(args.path)
        )
          app.addRecentDocument(args.path);
        return;
      }
      if (command === "set_dock_recents") return;
      if (command === "clipboard_write_png") {
        await clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([new Uint8Array(args.bytes)]),
          }),
        ]);
        return;
      }
      const result = await service.invoke(command, args);
      if (
        command === "pdf_open" &&
        typeof args.path === "string" &&
        !process.env.RUSTYPDF_SMOKE
      )
        app.addRecentDocument(args.path);
      return result;
    });
    ipcMain.handle("desktop:dialog", async (event, kind, options = {}) => {
      validate(event);
      const opts = {
        title: String(options.title ?? "RustyPDF"),
        defaultPath:
          typeof options.defaultPath === "string"
            ? options.defaultPath
            : undefined,
        filters: Array.isArray(options.filters) ? options.filters : undefined,
      };
      if (kind === "open") {
        const selected = await dialog.showOpenDialog(window!, {
          ...opts,
          properties: [
            options.directory ? "openDirectory" : "openFile",
            ...(options.multiple ? ["multiSelections" as const] : []),
          ],
        });
        return selected.canceled
          ? null
          : options.multiple
            ? selected.filePaths
            : (selected.filePaths[0] ?? null);
      }
      if (kind === "save") {
        const selected = await dialog.showSaveDialog(window!, opts);
        return selected.canceled ? null : (selected.filePath ?? null);
      }
      if (kind === "ask" || kind === "unsaved") {
        const result = await dialog.showMessageBox(window!, {
          title: opts.title,
          message: String(options.message ?? ""),
          type: "warning",
          buttons:
            kind === "unsaved"
              ? ["저장", "저장 안 함", "취소"]
              : [
                  String(options.okLabel ?? "확인"),
                  String(options.cancelLabel ?? "취소"),
                ],
          defaultId: 0,
          cancelId: kind === "unsaved" ? 2 : 1,
        });
        return kind === "unsaved"
          ? (["save", "discard", "cancel"] as const)[result.response]
          : result.response === 0;
      }
      throw new Error("Unknown dialog");
    });
    ipcMain.handle("desktop:read", async (event, file) => {
      validate(event);
      if (typeof file !== "string" || !path.isAbsolute(file))
        throw new Error("Invalid path");
      return new Uint8Array(await readFile(file));
    });
    ipcMain.handle("desktop:write", async (event, file, bytes) => {
      validate(event);
      if (
        typeof file !== "string" ||
        !path.isAbsolute(file) ||
        !(bytes instanceof Uint8Array)
      )
        throw new Error("Invalid file");
      await writeFile(file, bytes);
    });
    const create = () => {
      window = new BrowserWindow({
        title: "RustyPDF",
        width: 1280,
        height: 860,
        minWidth: 720,
        minHeight: 480,
        show: !process.env.RUSTYPDF_SMOKE,
        webPreferences: {
          preload: path.join(__dirname, "preload.cjs"),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, target) => {
        if (target !== url) event.preventDefault();
      });
      window.webContents.on("will-attach-webview", (event) =>
        event.preventDefault(),
      );
      const csp =
        "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'" +
        (dev ? " 'unsafe-inline'" : "") +
        "; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'" +
        (dev ? " ws://localhost:* ws://127.0.0.1:*" : "") +
        "; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-src 'none'";
      window.webContents.session.webRequest.onHeadersReceived(
        (details, callback) =>
          callback({
            responseHeaders: {
              ...details.responseHeaders,
              "Content-Security-Policy": [csp],
            },
          }),
      );
      window.on("close", (event) => {
        if (!allowExit) {
          event.preventDefault();
          window?.webContents.send("app-close-requested");
        }
      });
      window.on("closed", () => {
        window = null;
        subscribed = false;
      });
      void window.loadURL(url);
      if (process.env.RUSTYPDF_SMOKE) {
        let failed = false;
        window.webContents.on("console-message", (details) => {
          if (details.level === "error") {
            console.error(details.message);
            failed = true;
          }
        });
        window.webContents.on("did-fail-load", (_event, code, description) => {
          console.error(code, description);
          failed = true;
        });
        window.webContents.on("did-finish-load", () =>
          setTimeout(async () => {
            try {
              const ok = await window!.webContents.executeJavaScript(
                'Boolean(window.desktop && document.querySelector("#root")?.children.length)',
              );
              if (!ok)
                throw new Error(
                  "Renderer or sandbox preload did not initialize",
                );
              const priorClipboard = await Promise.all(
                (await clipboard.read()).map(
                  async (item) =>
                    new ClipboardItem(
                      Object.fromEntries(
                        await Promise.all(
                          item.types.map(async (type) => [
                            type,
                            await item.getType(type),
                          ]),
                        ),
                      ),
                    ),
                ),
              );
              try {
                await window!.webContents.executeJavaScript(`(async () => {
                  const canvas = document.createElement('canvas');
                  canvas.width = 2; canvas.height = 3;
                  const context = canvas.getContext('2d');
                  context.fillStyle = 'rgb(17,34,51)'; context.fillRect(0,0,2,3);
                  const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
                  await window.desktop.invoke('clipboard_write_png', {bytes: new Uint8Array(await blob.arrayBuffer())});
                })()`);
                const item = (await clipboard.read()).find((item) =>
                  item.types.includes("image/png"),
                );
                if (!item)
                  throw new Error("Clipboard PNG missing after IPC write");
                const image = nativeImage.createFromBuffer(
                  Buffer.from(
                    await (await item.getType("image/png")).arrayBuffer(),
                  ),
                );
                const size = image.getSize();
                const pixel = image.toBitmap().subarray(0, 4);
                if (
                  size.width !== 2 ||
                  size.height !== 3 ||
                  !pixel.equals(Buffer.from([51, 34, 17, 255]))
                )
                  throw new Error(
                    "Clipboard PNG round trip failed: " +
                      JSON.stringify({ size, pixel: [...pixel] }),
                  );
              } finally {
                if (priorClipboard.length)
                  await clipboard.write(priorClipboard);
                else clipboard.clear();
              }
              const canvas = await window!.webContents.executeJavaScript(
                `(() => {const c=[...document.querySelectorAll('canvas')].find(c=>c.width>=800);return c?{width:c.width,height:c.height,png:c.toDataURL('image/png').split(',')[1]}:null})()`,
              );
              if (!canvas || canvas.width !== 816 || canvas.height !== 1056)
                throw new Error(
                  "PDF.js fixture rendering expected 816x1056: " +
                    JSON.stringify(
                      canvas && { width: canvas.width, height: canvas.height },
                    ),
                );
              const editPath = path.join(
                path.dirname(smokePath!),
                "edit-fixture.pdf",
              );
              await copyFile(smokePath!, editPath);
              const opened = (await service.invoke("pdf_open", {
                path: editPath,
              })) as { id: string; revision: number };
              const args = {
                docId: opened.id,
                expectedRevision: opened.revision,
              };
              const ocr = (await service.invoke("pdf_ocr_page", {
                ...args,
                pageIndex: 0,
                image: new Uint8Array(Buffer.from(canvas.png, "base64")),
                imageWidth: canvas.width,
                imageHeight: canvas.height,
              })) as { text: string };
              if (!ocr.text.toLowerCase().includes("rustypdf"))
                throw new Error("Offline OCR failed fixture text");
              await service.invoke("pdf_ocr_flush", args);
              const edited = (await service.invoke("pdf_rotate_pages", {
                ...args,
                indices: [0],
                direction: 1,
              })) as { revision: number };
              const targetPath = path.join(
                path.dirname(smokePath!),
                "saved.pdf",
              );
              const saved = (await service.invoke("pdf_save_document", {
                docId: opened.id,
                expectedRevision: edited.revision,
                targetPath,
              })) as { revision: number };
              await service.invoke("export_annotated_pdf", {
                docId: opened.id,
                expectedRevision: saved.revision,
                targetPath: path.join(path.dirname(smokePath!), "export.pdf"),
                data: {
                  version: 2,
                  sourcePath: targetPath,
                  updatedAt: new Date().toISOString(),
                  annotations: [
                    {
                      id: "smoke-text",
                      page: 0,
                      type: "text",
                      rect: { x: 70, y: 80, w: 450, h: 90 },
                      rotation: 0,
                      style: { color: "#112233", width: 1, fontSize: 24 },
                      payload: {
                        text: "한글 내보내기 RustyPDF",
                        layout: [
                          {
                            baseline: 28,
                            fragments: [
                              {
                                text: "한글 내보내기 RustyPDF",
                                x: 0,
                                fontSize: 24,
                                color: "#112233",
                                bold: true,
                                italic: true,
                                underline: true,
                              },
                            ],
                          },
                        ],
                      },
                    },
                  ],
                },
              });
              await writeFile(
                path.join(path.dirname(smokePath!), "screenshot.png"),
                (await window!.webContents.capturePage()).toPNG(),
              );
              await window!.webContents.executeJavaScript(
                `document.querySelector('.viewer-scroll').scrollTop=400`,
              );
              await new Promise((resolve) => setTimeout(resolve, 400));
              const scrolling = await window!.webContents.executeJavaScript(
                `document.querySelector('.viewer-scroll').scrollTop`,
              );
              if (Math.abs(scrolling - 400) > 2)
                throw new Error("Scroll snapped: " + scrolling);
              const exportPath = path.join(
                path.dirname(smokePath!),
                "export.pdf",
              );
              enqueue([exportPath]);
              await new Promise((resolve) => setTimeout(resolve, 1500));
              await writeFile(
                path.join(path.dirname(smokePath!), "export-screenshot.png"),
                (await window!.webContents.capturePage()).toPNG(),
              );
              await window!.webContents.executeJavaScript(
                `(() => { const tab = document.querySelectorAll('.tab-item')[0]; tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); if (!tab.classList.contains('active')) throw new Error('Smoke tab 0 did not activate'); })()`,
              );
              await new Promise((resolve) => setTimeout(resolve, 400));
              const restored = await window!.webContents.executeJavaScript(
                `document.querySelector('.viewer-scroll').scrollTop`,
              );
              if (Math.abs(restored - 400) > 2)
                throw new Error("Tab scroll restore failed: " + restored);
              await window!.webContents.executeJavaScript(
                `document.querySelector('button[title="다음 페이지"]').click()`,
              );
              await new Promise((resolve) => setTimeout(resolve, 400));
              const navigated = await window!.webContents.executeJavaScript(
                `document.querySelector('.viewer-scroll').scrollTop`,
              );
              if (navigated <= 400)
                throw new Error("Explicit next page navigation failed");
              await window!.webContents.executeJavaScript(
                `(() => { const tab = document.querySelectorAll('.tab-item')[1]; tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); if (!tab.classList.contains('active')) throw new Error('Smoke tab 1 did not activate'); })()`,
              );
              await new Promise((resolve) => setTimeout(resolve, 200));
              await window!.webContents.executeJavaScript(
                `(() => { const tab = document.querySelectorAll('.tab-item')[0]; tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); if (!tab.classList.contains('active')) throw new Error('Smoke tab 0 did not activate'); })()`,
              );
              await new Promise((resolve) => setTimeout(resolve, 400));
              const navRestored = await window!.webContents.executeJavaScript(
                `document.querySelector('.viewer-scroll').scrollTop`,
              );
              if (Math.abs(navRestored - navigated) > 2)
                throw new Error(
                  "Navigation tab restore failed: " +
                    navRestored +
                    " vs " +
                    navigated,
                );
              console.log(
                "Electron smoke passed: sandbox preload, PNG clipboard round trip, PDF.js 816x1056, offline eng+kor OCR, rotate/save/export, scroll/tab/navigation restore; artifacts " +
                  path.dirname(smokePath!),
              );
            } catch (error) {
              console.error(error);
              failed = true;
            }
            allowExit = true;
            await service.dispose().catch((error) => console.error(error));
            app.exit(failed ? 1 : 0);
          }, 3000),
        );
      }
    };
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: "RustyPDF",
          submenu: [{ role: "about" }, { type: "separator" }, { role: "quit" }],
        },
        {
          label: "File",
          submenu: [
            {
              role: "recentDocuments",
              submenu: [{ role: "clearRecentDocuments" }],
            },
          ],
        },
        { role: "editMenu" },
        { role: "viewMenu" },
      ]),
    );
    enqueue(process.argv.slice(1).filter((p) => path.isAbsolute(p)));
    if (process.env.RUSTYPDF_SMOKE) {
      const { PDFDocument, StandardFonts } = await import("pdf-lib");
      const fixture = await PDFDocument.create();
      const font = await fixture.embedFont(StandardFonts.Helvetica);
      fixture
        .addPage([612, 792])
        .drawText("RustyPDF offline smoke", { x: 40, y: 720, font, size: 24 });
      fixture
        .addPage([612, 792])
        .drawText("Second smoke page", { x: 40, y: 720, font, size: 24 });
      fixture
        .addPage([612, 792])
        .drawText("Third smoke page", { x: 40, y: 720, font, size: 24 });
      const temporary = await mkdtemp(
        path.join(app.getPath("temp"), "rustypdf-smoke-"),
      );
      smokePath = path.join(temporary, "fixture.pdf");
      await writeFile(smokePath, await fixture.save());
      enqueue([smokePath]);
    }
    create();
    app.on("activate", () => {
      if (!window) create();
    });
  });
  app.on("before-quit", (event) => {
    if (!allowExit && window) {
      event.preventDefault();
      window.webContents.send("app-close-requested");
      return;
    }
    if (!quitting && service) {
      event.preventDefault();
      quitting = true;
      void service
        .dispose()
        .catch((error) => console.error(error))
        .finally(() => app.quit());
    }
  });
  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
