import { invoke } from "../platform/desktop";
import { activeTab } from "../state/document";
import { navigateToPage } from "./navigation";

/** Only these schemes may leave the app via open_external. */
export function isSafeExternalUrl(url: unknown): url is string {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url.trim());
    return u.protocol === "http:" || u.protocol === "https:" || u.protocol === "mailto:";
  } catch {
    return false;
  }
}

export interface DestDoc {
  getDestination(id: string): Promise<unknown[] | null>;
  getPageIndex(ref: any): Promise<number>;
}

/** Resolve a named or explicit destination to a zero-based page index, or null. */
export async function resolveDestToPageIndex(
  doc: DestDoc,
  dest: unknown,
): Promise<number | null> {
  try {
    let explicit: unknown = dest;
    if (typeof dest === "string") explicit = await doc.getDestination(dest);
    if (!Array.isArray(explicit) || explicit.length === 0) return null;
    const target = explicit[0];
    if (typeof target === "number" && Number.isInteger(target)) return target >= 0 ? target : null;
    if (target && typeof target === "object") return await doc.getPageIndex(target);
    return null;
  } catch {
    return null;
  }
}

export function namedActionTarget(action: string, current: number, count: number): number | null {
  let t: number;
  switch (action) {
    case "NextPage": t = current + 1; break;
    case "PrevPage": t = current - 1; break;
    case "FirstPage": t = 0; break;
    case "LastPage": t = count - 1; break;
    default: return null;
  }
  return t >= 0 && t < count ? t : null;
}

export interface PdfLinkService {
  externalLinkEnabled: boolean;
  pagesCount: number;
  page: number;
  rotation: number;
  isInPresentationMode: boolean;
  goToDestination(dest: unknown): Promise<void>;
  goToPage(n: number): void;
  addLinkAttributes(link: HTMLAnchorElement, url: string, newWindow?: boolean): void;
  getDestinationHash(dest: unknown): string;
  getAnchorUrl(hash: string): string;
  setHash(hash: string): void;
  executeNamedAction(action: string): void;
  executeSetOCGState(): void;
  navigateTo(dest: unknown): Promise<void>;
  eventBus: { dispatch(): void; on(): void; off(): void };
}

export function createLinkService(doc: DestDoc): PdfLinkService {
  const goTo = async (dest: unknown) => {
    const idx = await resolveDestToPageIndex(doc, dest);
    if (idx !== null) navigateToPage(idx);
  };
  return {
    externalLinkEnabled: true,
    get pagesCount() { return activeTab()?.pageCount ?? 0; },
    get page() { return (activeTab()?.currentPage ?? 0) + 1; },
    set page(n: number) { navigateToPage(n - 1); },
    rotation: 0,
    isInPresentationMode: false,
    goToDestination: goTo,
    navigateTo: goTo,
    goToPage(n: number) { navigateToPage(n - 1); },
    addLinkAttributes(link, url) {
      link.href = "#";
      link.removeAttribute("target");
      link.onclick = (event) => {
        event.preventDefault();
        if (isSafeExternalUrl(url)) void invoke("open_external", { url });
        return false;
      };
    },
    getDestinationHash: () => "#",
    getAnchorUrl: () => "#",
    setHash() {},
    executeNamedAction(action) {
      const tab = activeTab();
      if (!tab) return;
      const t = namedActionTarget(action, tab.currentPage, tab.pageCount);
      if (t !== null) navigateToPage(t);
    },
    executeSetOCGState() {},
    eventBus: { dispatch() {}, on() {}, off() {} },
  };
}

export interface OutlineNode {
  title: string;
  dest: unknown;
  items?: OutlineNode[];
}
export interface FlatOutlineRow {
  key: string;
  title: string;
  dest: unknown;
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
}

/** Flatten a nested outline into visible rows; `expanded` holds keys like "0.2". */
export function flattenOutline(
  nodes: OutlineNode[],
  expanded: ReadonlySet<string>,
  depth = 0,
  prefix = "",
): FlatOutlineRow[] {
  const rows: FlatOutlineRow[] = [];
  nodes.forEach((n, i) => {
    const key = prefix ? `${prefix}.${i}` : String(i);
    const hasChildren = !!n.items?.length;
    const isOpen = hasChildren && expanded.has(key);
    rows.push({ key, title: n.title, dest: n.dest, depth, hasChildren, expanded: isOpen });
    if (isOpen) rows.push(...flattenOutline(n.items!, expanded, depth + 1, key));
  });
  return rows;
}
