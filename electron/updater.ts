export interface UpdaterDeps {
  isPackaged: () => boolean;
  env: Record<string, string | undefined>;
  load: (name: string) => unknown;
  log: (message: string, error?: unknown) => void;
}

const defaultDeps: UpdaterDeps = {
  isPackaged: () => Boolean(require("electron").app?.isPackaged),
  env: process.env,
  load: (name) => require(name),
  log: (message, error) => console.error(message, error),
};

/** Off unless packaged and RUSTYPDF_UPDATE_URL is set. electron-updater is an optional, external module. */
export function initAutoUpdates(deps: Partial<UpdaterDeps> = {}): void {
  const d = { ...defaultDeps, ...deps };
  try {
    const url = d.env.RUSTYPDF_UPDATE_URL;
    if (!url || !d.isPackaged()) return;
    const mod = d.load("electron-updater") as { autoUpdater?: any };
    const updater = mod.autoUpdater;
    if (!updater) throw new Error("autoUpdater missing");
    updater.setFeedURL({ provider: "generic", url });
    void Promise.resolve(updater.checkForUpdatesAndNotify()).catch((e: unknown) => d.log("update check failed", e));
  } catch (e) {
    d.log("auto update disabled", e);
  }
}
