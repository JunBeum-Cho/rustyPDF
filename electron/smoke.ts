import { clipboard, ClipboardItem, nativeImage, type BrowserWindow } from "electron";
import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type SmokeContext = {
  window: BrowserWindow;
  service: { invoke(command: string, args?: Record<string, unknown>): Promise<unknown> };
  smokePath: string;
  enqueue(paths: string[]): void;
};

/** Runs the Electron smoke checks; resolves true when everything passed. */
export async function runSmoke({
  window,
  service,
  smokePath,
  enqueue,
}: SmokeContext): Promise<boolean> {
  try {
  const ok = await window.webContents.executeJavaScript(
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
    await window.webContents.executeJavaScript(`(async () => {
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
  const canvas = await window.webContents.executeJavaScript(
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
    path.dirname(smokePath),
    "edit-fixture.pdf",
  );
  await copyFile(smokePath, editPath);
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
    path.dirname(smokePath),
    "saved.pdf",
  );
  const saved = (await service.invoke("pdf_save_document", {
    docId: opened.id,
    expectedRevision: edited.revision,
    targetPath,
    annotations: {
      version: 2,
      sourcePath: targetPath,
      updatedAt: new Date().toISOString(),
      annotations: [],
    },
    includeOcr: false,
  })) as { revision: number };
  await service.invoke("export_annotated_pdf", {
    docId: opened.id,
    expectedRevision: saved.revision,
    targetPath: path.join(path.dirname(smokePath), "export.pdf"),
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
    path.join(path.dirname(smokePath), "screenshot.png"),
    (await window.webContents.capturePage()).toPNG(),
  );
  await window.webContents.executeJavaScript(
    `document.querySelector('.viewer-scroll').scrollTop=400`,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const scrolling = await window.webContents.executeJavaScript(
    `document.querySelector('.viewer-scroll').scrollTop`,
  );
  if (Math.abs(scrolling - 400) > 2)
    throw new Error("Scroll snapped: " + scrolling);
  const exportPath = path.join(
    path.dirname(smokePath),
    "export.pdf",
  );
  enqueue([exportPath]);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await writeFile(
    path.join(path.dirname(smokePath), "export-screenshot.png"),
    (await window.webContents.capturePage()).toPNG(),
  );
  await window.webContents.executeJavaScript(
    `(() => { const tab = document.querySelectorAll('.tab-item')[0]; tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); if (!tab.classList.contains('active')) throw new Error('Smoke tab 0 did not activate'); })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const restored = await window.webContents.executeJavaScript(
    `document.querySelector('.viewer-scroll').scrollTop`,
  );
  if (Math.abs(restored - 400) > 2)
    throw new Error("Tab scroll restore failed: " + restored);
  await window.webContents.executeJavaScript(
    `document.querySelector('button[title="다음 페이지"]').click()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const navigated = await window.webContents.executeJavaScript(
    `document.querySelector('.viewer-scroll').scrollTop`,
  );
  if (navigated <= 400)
    throw new Error("Explicit next page navigation failed");
  await window.webContents.executeJavaScript(
    `(() => { const tab = document.querySelectorAll('.tab-item')[1]; tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); if (!tab.classList.contains('active')) throw new Error('Smoke tab 1 did not activate'); })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 200));
  await window.webContents.executeJavaScript(
    `(() => { const tab = document.querySelectorAll('.tab-item')[0]; tab.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 })); if (!tab.classList.contains('active')) throw new Error('Smoke tab 0 did not activate'); })()`,
  );
  await new Promise((resolve) => setTimeout(resolve, 400));
  const navRestored = await window.webContents.executeJavaScript(
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
      path.dirname(smokePath),
  );
    return true;
  } catch (error) {
    console.error(error);
    return false;
  }
}
