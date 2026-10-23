import { contextBridge, ipcRenderer, webUtils } from "electron";
import { assertCommand, EVENTS } from "./protocol";
contextBridge.exposeInMainWorld("desktop", {
  invoke: (command: string, args: Record<string, unknown> = {}) => {
    assertCommand(command);
    return ipcRenderer.invoke("desktop:command", command, args);
  },
  open: (options: unknown) =>
    ipcRenderer.invoke("desktop:dialog", "open", options),
  save: (options: unknown) =>
    ipcRenderer.invoke("desktop:dialog", "save", options),
  ask: (message: string, options: unknown) =>
    ipcRenderer.invoke("desktop:dialog", "ask", {
      message,
      ...(options as object),
    }),
  confirmUnsaved: (message: string) =>
    ipcRenderer.invoke("desktop:dialog", "unsaved", { message }),
  readFile: (path: string) => ipcRenderer.invoke("desktop:read", path),
  writeFile: (path: string, bytes: Uint8Array) =>
    ipcRenderer.invoke("desktop:write", path, bytes),
  filePath: (file: File) => {
    const path = webUtils.getPathForFile(file);
    if (path) ipcRenderer.send("desktop:grant", path);
    return path;
  },
  listen: (name: string, callback: (payload: unknown) => void) => {
    if (!EVENTS.has(name)) throw new Error("Unknown desktop event");
    const handler = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on(name, handler);
    return () => ipcRenderer.removeListener(name, handler);
  },
});
