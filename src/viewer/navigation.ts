import { createStore } from 'solid-js/store';
import { activeTab, documentStore, updateActiveTab } from '../state/document';
export type FitMode = 'manual' | 'width' | 'page';
const [modes, setModes] = createStore<Record<string, FitMode>>({});
export const navigationMode = (tabId = activeTab()?.tabId): FitMode => tabId ? modes[tabId] ?? 'manual' : 'manual';
export function setNavigationMode(mode: FitMode) {
  const tab = activeTab();
  if (!tab) return;
  for (const id of Object.keys(modes)) if (!documentStore.tabs.some(t => t.tabId === id)) setModes(id, undefined!);
  setModes(tab.tabId, mode);
}
export function setManualZoom(zoom: number) {
  setNavigationMode('manual');
  updateActiveTab(t => { t.zoom = Math.min(4, Math.max(.25, zoom)); });
}
export function parsePageEntry(value: string, count: number): number | null {
  if (!/^-?\d+$/.test(value.trim()) || count < 1) return null;
  const page = Number(value);
  return Number.isSafeInteger(page) ? Math.max(0, Math.min(count - 1, page - 1)) : null;
}
export function parseZoomEntry(value: string): number | null {
  const normalized = value.trim().replace(/%$/, '');
  if (!/^\d+(\.\d+)?$/.test(normalized)) return null;
  const zoom = Number(normalized) / 100;
  return zoom >= .25 && zoom <= 4 ? zoom : null;
}
export const pxPerPt = (zoom: number) => zoom * 4 / 3;
export const ZOOM_STEPS = [.25, .5, .75, 1, 1.25, 1.5, 2, 3, 4];
export function zoomIn() {
  const cur = activeTab()?.zoom;
  if (cur == null) return;
  const next = ZOOM_STEPS.find(z => z > cur + 1e-6);
  if (next != null) setManualZoom(next);
}
export function zoomOut() {
  const cur = activeTab()?.zoom;
  if (cur == null) return;
  const prev = [...ZOOM_STEPS].reverse().find(z => z < cur - 1e-6);
  if (prev != null) setManualZoom(prev);
}
/** Page dims in pt; returns user zoom (px fit / (4/3)) clamped to 0.25-4. */
export function fitZoom(mode: Exclude<FitMode, 'manual'>, viewW: number, viewH: number, pageW: number, pageH: number): number {
  const fitW = (viewW - 32) / pageW;
  const px = mode === 'width' ? fitW : Math.min(fitW, (viewH - 32) / pageH);
  return Math.max(.25, Math.min(4, px / (4 / 3)));
}
export function navigateToPage(index: number) {
  updateActiveTab(t => { t.currentPage = Math.max(0, Math.min(t.pageCount - 1, index)); t.navigationVersion = (t.navigationVersion ?? 0) + 1; });
}
