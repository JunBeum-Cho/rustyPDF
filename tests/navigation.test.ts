import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePageEntry, parseZoomEntry, fitZoom, navigationMode, setNavigationMode, setManualZoom, pxPerPt, ZOOM_STEPS, zoomIn, zoomOut } from '../src/viewer/navigation';
test('page entry rejects malformed values and clamps integer pages', () => {
  for (const value of ['', ' ', '1.5', '1e2', 'abc']) assert.equal(parsePageEntry(value, 10), null);
  assert.equal(parsePageEntry('0', 10), 0);
  assert.equal(parsePageEntry('999', 10), 9);
  assert.equal(parsePageEntry('3', 10), 2);
});
test('zoom accepts percentages only in supported range', () => {
  assert.equal(parseZoomEntry('125%'), 1.25);
  for (const value of ['', 'abc', '24', '401']) assert.equal(parseZoomEntry(value), null);
});
test('pxPerPt converts user zoom to CSS px per pt', () => {
  assert.equal(pxPerPt(1), 4 / 3);
  assert.equal(pxPerPt(.75), 1);
});
test('fit zoom is user zoom from pt dims with 16px padding per side', () => {
  assert.equal(fitZoom('width', 632, 832, 600, 800), .75);
  assert.equal(fitZoom('page', 632, 432, 600, 800), .375);
  assert.equal(fitZoom('width', 4000, 832, 600, 800), 4);
  assert.equal(fitZoom('width', 100, 832, 600, 800), .25);
});
test('mixed page sizes: fit from the widest/largest page', () => {
  const pages = [{ width: 300, height: 400 }, { width: 600, height: 800 }, { width: 400, height: 1000 }];
  const maxW = Math.max(...pages.map(p => p.width)), maxH = Math.max(...pages.map(p => p.height));
  assert.equal(fitZoom('width', 632, 832, maxW, maxH), .75);
  assert.equal(fitZoom('page', 632, 832, maxW, maxH), 800 / 1000 / (4 / 3));
});
test('zoom steps move to neighbouring steps in manual mode', async () => {
  const { setDocumentStore, emptyAnnotationTabState, activeTab } = await import('../src/state/document');
  const t = { tabId: 'z', docId: 'z', revision: 1, annotationDocumentKey: 'z', path: 'z.pdf', pageCount: 1, pages: [{ index: 0, width: 600, height: 800, rotation: 0 as const }], fileSize: 1, contentVersion: 1, zoom: 1.1, rotation: 0 as const, currentPage: 0, selectedPageIndices: [0], pageAnchor: 0, navigationVersion: 0, pageDirty: false, annotations: emptyAnnotationTabState() };
  setDocumentStore('tabs', [t]);
  setDocumentStore('activeTabId', 'z');
  setNavigationMode('width');
  zoomIn();
  assert.equal(activeTab()?.zoom, 1.25);
  assert.equal(navigationMode('z'), 'manual');
  zoomOut(); zoomOut();
  assert.equal(activeTab()?.zoom, .75);
  assert.deepEqual(ZOOM_STEPS, [.25, .5, .75, 1, 1.25, 1.5, 2, 3, 4]);
  setDocumentStore('tabs', []);
  setDocumentStore('activeTabId', null);
});
test('manual zoom clears only the active tab fit mode and navigation is explicit', async () => {
  const { setDocumentStore, emptyAnnotationTabState, activeTab } = await import('../src/state/document');
  const { navigateToPage } = await import('../src/viewer/navigation');
  const makeTab = (tabId: string) => ({ tabId, docId: tabId, revision: 1, annotationDocumentKey: tabId, path: `${tabId}.pdf`, pageCount: 3, pages: [0, 1, 2].map(index => ({ index, width: 600, height: 800, rotation: 0 as const })), fileSize: 1, contentVersion: 1, zoom: 1, rotation: 0 as const, currentPage: 0, selectedPageIndices: [0], pageAnchor: 0, navigationVersion: 0, pageDirty: false, annotations: emptyAnnotationTabState() });
  setDocumentStore('tabs', [makeTab('a'), makeTab('b')]);
  setDocumentStore('activeTabId', 'a');
  setNavigationMode('width');
  setDocumentStore('activeTabId', 'b');
  setNavigationMode('page');
  setManualZoom(1.5);
  assert.equal(navigationMode('b'), 'manual');
  assert.equal(navigationMode('a'), 'width');
  assert.equal(activeTab()?.zoom, 1.5);
  navigateToPage(99);
  assert.equal(activeTab()?.currentPage, 2);
  assert.equal(activeTab()?.navigationVersion, 1);
  setDocumentStore('tabs', []);
  setDocumentStore('activeTabId', null);
});
