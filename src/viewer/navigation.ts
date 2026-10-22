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
export function fitZoom(mode: Exclude<FitMode, 'manual'>, width: number, height: number, pageWidth: number, pageHeight: number, rotation: number): number {
  const swap = rotation === 90 || rotation === 270;
  const w = swap ? pageHeight : pageWidth, h = swap ? pageWidth : pageHeight;
  const fit = mode === 'width' ? (width - 32) / w : Math.min((width - 32) / w, (height - 32) / h);
  return Math.max(.25, Math.min(4, fit));
}
export function navigateToPage(index: number) {
  updateActiveTab(t => { t.currentPage = Math.max(0, Math.min(t.pageCount - 1, index)); t.navigationVersion = (t.navigationVersion ?? 0) + 1; });
}
