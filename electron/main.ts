import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  clipboard,
  ClipboardItem,
  nativeImage,
  shell,
  Menu,
} from "electron";
import {
  readFile,
  writeFile,
  mkdtemp,
  mkdir,
  rename,
  rm,
  stat,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
if (process.env.RUSTYPDF_SMOKE)
  app.setPath(
    "userData",
    mkdtempSync(path.join(tmpdir(), "rustypdf-smoke-data-")),
  );
import { pathToFileURL } from "node:url";
import { PdfWorkerClient } from "./worker-client";
import {
  assertCommand,
  assertSender,
  takeOpenPaths,
  EVENTS,
} from "./protocol";
import { PathGrants, draftFileName, safeExternalUrl } from "./grants";
import { initAutoUpdates } from "./updater";
const DRAFT_LIMIT = 200 * 1024 * 1024;
const NATIVE_IMAGE = /\.(png|jpe?g)$/i;
let smokePath: string | undefined;
let window: BrowserWindow | null = null;
let service: PdfWorkerClient;
let allowExit = false;
let quitting = false;
let subscribed = false;
let askedUnresponsive = false;
const queue: string[] = [];
const grants = new PathGrants();
const root = path.resolve(__dirname, "..");
const dev = process.env.RUSTYPDF_DEV_URL;
const url = dev ?? pathToFileURL(path.join(root, "dist/index.html")).href;
function enqueue(paths: string[]) {
  const pdfs = paths.filter((p) => p.toLowerCase().endsWith(".pdf"));
  for (const file of pdfs) grants.grant(file);
  queue.push(...pdfs);
  if (subscribed && window)
    window.webContents.send("open-pdfs", takeOpenPaths(queue));
}
function sendEvent(name: string, payload?: unknown) {
  if (!EVENTS.has(name) || !window || window.isDestroyed()) return;
  window.webContents.send(name, payload);
}
async function convertImages(paths: unknown[], temp: string) {
  const out: string[] = [];
  for (const [index, file] of paths.entries()) {
    const source = String(file);
    if (NATIVE_IMAGE.test(source)) {
      out.push(source);
      continue;
    }
    const image = nativeImage.createFromPath(source);
    if (image.isEmpty())
      throw new Error(
        `이 이미지 형식은 이 컴퓨터에서 지원되지 않습니다: ${path.basename(source)}`,
      );
    const target = path.join(temp, `${index}.png`);
    await writeFile(target, image.toPNG());
    out.push(target);
  }
  return out;
}
async function printImages(args: Record<string, unknown>) {
  const pages = args.pages;
  if (!Array.isArray(pages) || !pages.length) throw new Error("Invalid pages");
  const temp = await mkdtemp(path.join(app.getPath("temp"), "rustypdf-print-"));
  let printer: BrowserWindow | null = null;
  try {
    const body: string[] = [];
    let first = { w: 612, h: 792 };
    for (const [index, page] of pages.entries()) {
      const { png, widthPt, heightPt } = page as {
        png: Uint8Array;
        widthPt: number;
        heightPt: number;
      };
      if (!(png instanceof Uint8Array) || !(widthPt > 0) || !(heightPt > 0))
        throw new Error("Invalid pages");
      if (index === 0) first = { w: widthPt, h: heightPt };
      await writeFile(path.join(temp, `${index}.png`), png);
      body.push(
        `<div class="p" style="width:${widthPt}pt;height:${heightPt}pt"><img src="${index}.png"></div>`,
      );
    }
    const html =
      `<!doctype html><meta charset="utf-8"><title>${String(args.title ?? "RustyPDF").replace(/[<&]/g, "")}</title>` +
      `<style>@page{margin:0;size:${first.w}pt ${first.h}pt}html,body{margin:0;padding:0}` +
      `.p{page-break-after:always;overflow:hidden}img{display:block;width:100%;height:100%}</style>${body.join("")}`;
    const file = path.join(temp, "print.html");
    await writeFile(file, html);
    printer = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
    await printer.loadFile(file);
    const contents = printer.webContents;
    return await new Promise<boolean>((resolve) =>
      contents.print({ silent: false, printBackground: true }, (success) =>
        resolve(success),
      ),
    );
  } finally {
    printer?.close();
    await rm(temp, { recursive: true, force: true });
  }
}
function buildMenu() {
  const packaged = app.isPackaged;
  if (packaged && process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin"
        ? [
            {
              label: "RustyPDF",
              submenu: [
                { role: "about" as const },
                { type: "separator" as const },
                { role: "quit" as const },
              ],
            },
          ]
        : []),
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
      packaged
        ? {
            label: "View",
            submenu: [{ role: "togglefullscreen" }],
          }
        : { role: "viewMenu" },
    ]),
  );
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
    const fontsDir = app.isPackaged
      ? path.join(app.getAppPath(), "dist/fonts")
      : path.join(root, "resources/fonts");
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
    service = new PdfWorkerClient(
      path.join(__dirname, "worker.cjs"),
      {
        dataDir: app.getPath("userData"),
        legacyDataDirs: [legacy],
        assetsDir,
        fontsDir,
      },
      {
        onEvent: (name, payload) => sendEvent(name, payload),
        onRestart: () => sendEvent("pdf-service-restarted"),
      },
    );
    const draftsDir = path.join(app.getPath("userData"), "drafts");
    const validate = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) => {
      if (
        !window ||
        event.sender !== window.webContents ||
        event.senderFrame !== window.webContents.mainFrame
      )
        throw new Error("Foreign desktop sender");
      assertSender(event.senderFrame.url, url);
    };
    ipcMain.on("desktop:grant", (event, file) => {
      try {
        validate(event);
        if (typeof file === "string" && file && path.isAbsolute(file))
          grants.grant(file);
      } catch {
        /* foreign sender: ignore */
      }
    });
    ipcMain.handle("desktop:command", async (event, command, args = {}) => {
      validate(event);
      assertCommand(command);
      if (!args || typeof args !== "object" || Array.isArray(args))
        throw new Error("Invalid arguments");
      switch (command) {
        case "initial_open_paths":
          subscribed = true;
          return takeOpenPaths(queue);
        case "request_app_exit":
          allowExit = true;
          app.quit();
          return;
        case "note_recent_document":
          if (
            !process.env.RUSTYPDF_SMOKE &&
            typeof args.path === "string" &&
            path.isAbsolute(args.path)
          )
            app.addRecentDocument(args.path);
          return;
        case "clipboard_write_png":
          await clipboard.write([
            new ClipboardItem({
              "image/png": new Blob([new Uint8Array(args.bytes)]),
            }),
          ]);
          return;
        case "print_images":
          return printImages(args);
        case "open_external":
          await shell.openExternal(safeExternalUrl(args.url));
          return;
        case "paths_exist": {
          if (!Array.isArray(args.paths)) throw new Error("Invalid arguments");
          return Promise.all(
            args.paths.map((file: unknown) =>
              typeof file === "string" && path.isAbsolute(file)
                ? stat(file).then(
                    () => true,
                    () => false,
                  )
                : false,
            ),
          );
        }
        case "draft_write": {
          if (
            typeof args.path !== "string" ||
            !path.isAbsolute(args.path) ||
            typeof args.json !== "string"
          )
            throw new Error("Invalid arguments");
          if (Buffer.byteLength(args.json) > DRAFT_LIMIT)
            throw new Error("임시 저장 데이터가 너무 큽니다.");
          await mkdir(draftsDir, { recursive: true });
          const target = path.join(draftsDir, draftFileName(args.path));
          const temp = `${target}.${process.pid}.tmp`;
          await writeFile(temp, args.json);
          await rename(temp, target);
          return;
        }
        case "draft_read": {
          if (typeof args.path !== "string" || !path.isAbsolute(args.path))
            throw new Error("Invalid arguments");
          try {
            return await readFile(
              path.join(draftsDir, draftFileName(args.path)),
              "utf8",
            );
          } catch {
            return null;
          }
        }
        case "draft_delete": {
          if (typeof args.path !== "string" || !path.isAbsolute(args.path))
            throw new Error("Invalid arguments");
          await unlink(
            path.join(draftsDir, draftFileName(args.path)),
          ).catch(() => undefined);
          return;
        }
      }
      let checked = grants.checkCommand(command, args);
      if (command === "pdf_create_from_images") {
        const base = path.join(app.getPath("temp"), "rustypdf-images");
        await mkdir(base, { recursive: true });
        const temp = await mkdtemp(path.join(base, "run-"));
        try {
          checked = {
            ...checked,
            paths: await convertImages(checked.paths as unknown[], temp),
          };
          return await service.invoke(command, checked);
        } finally {
          await rm(temp, { recursive: true, force: true });
        }
      }
      return service.invoke(command, checked);
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
        if (selected.canceled) return null;
        for (const file of selected.filePaths) grants.grant(file);
        return options.multiple
          ? selected.filePaths
          : (selected.filePaths[0] ?? null);
      }
      if (kind === "save") {
        const selected = await dialog.showSaveDialog(window!, opts);
        if (selected.canceled || !selected.filePath) return null;
        grants.grant(selected.filePath, { write: true });
        return selected.filePath;
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
      if (!grants.has(file)) throw new Error("허용되지 않은 파일 경로입니다.");
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
      if (!grants.canWrite(file))
        throw new Error("허용되지 않은 파일 경로입니다.");
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
          devTools: !app.isPackaged,
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
      window.on("unresponsive", async () => {
        if (askedUnresponsive || !window) return;
        askedUnresponsive = true;
        const target = window;
        const { response } = await dialog.showMessageBox(target, {
          type: "warning",
          title: "RustyPDF",
          message: "창이 응답하지 않습니다.",
          buttons: ["기다리기", "강제 종료"],
          defaultId: 0,
          cancelId: 0,
        });
        askedUnresponsive = false;
        if (response === 1 && !target.isDestroyed())
          target.webContents.forcefullyCrashRenderer();
      });
      window.webContents.on("render-process-gone", async (_event, details) => {
        if (details.reason === "clean-exit" || quitting || !window) return;
        if (process.env.RUSTYPDF_SMOKE) return;
        const target = window;
        const { response } = await dialog.showMessageBox(target, {
          type: "error",
          title: "RustyPDF",
          message: "창이 예기치 않게 종료되었습니다.",
          buttons: ["다시 불러오기", "종료"],
          defaultId: 0,
          cancelId: 1,
        });
        if (response === 0 && !target.isDestroyed()) target.reload();
        else {
          allowExit = true;
          app.quit();
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
            const { runSmoke } = await import("./smoke");
            const passed = await runSmoke({
              window: window!,
              service,
              smokePath: smokePath!,
              enqueue,
            });
            if (!passed) failed = true;
            allowExit = true;
            await service.dispose().catch((error) => console.error(error));
            app.exit(failed ? 1 : 0);
          }, 3000),
        );
      }
    };
    buildMenu();
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
    initAutoUpdates();
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
