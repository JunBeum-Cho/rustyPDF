export interface TabLike {
  tabId: string;
  path: string;
}

const segments = (path: string): string[] => path.split(/[\\/]/).filter(Boolean);

export function tabLabels(tabs: TabLike[]): Record<string, string> {
  const counts = new Map<string, number>();
  for (const tab of tabs) {
    const name = segments(tab.path).pop() ?? tab.path;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const out: Record<string, string> = {};
  for (const tab of tabs) {
    const parts = segments(tab.path);
    const name = parts.pop() ?? tab.path;
    const parent = parts.pop();
    out[tab.tabId] =
      (counts.get(name) ?? 0) > 1 && parent && !tab.path.startsWith("unsaved://")
        ? `${name} — ${parent}`
        : name;
  }
  return out;
}

export function moveTab<T>(tabs: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= tabs.length) return tabs;
  const target = Math.max(0, Math.min(tabs.length - 1, to));
  if (target === from) return tabs;
  const next = tabs.slice();
  const [item] = next.splice(from, 1);
  next.splice(target, 0, item);
  return next;
}

export type CloseMode = "self" | "others" | "right";

export function tabsToClose(tabs: TabLike[], tabId: string, mode: CloseMode): string[] {
  const index = tabs.findIndex((tab) => tab.tabId === tabId);
  if (index < 0) return [];
  if (mode === "self") return [tabId];
  if (mode === "right") return tabs.slice(index + 1).map((tab) => tab.tabId);
  return tabs.filter((tab) => tab.tabId !== tabId).map((tab) => tab.tabId);
}

/** Close one at a time so each dirty tab prompts; stop when the user cancels. */
export async function closeSequentially(
  ids: string[],
  close: (id: string) => Promise<void>,
  stillOpen: (id: string) => boolean,
): Promise<void> {
  for (const id of ids) {
    if (!stillOpen(id)) continue;
    await close(id);
    if (stillOpen(id)) return;
  }
}
