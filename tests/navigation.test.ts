import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parsePageEntry, parseZoomEntry, fitZoom, navigationMode, setNavigationMode, setManualZoom } from '../src/viewer/navigation';
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
test('fit uses current geometry, viewport and rotation', () => {
  assert.equal(fitZoom('width', 632, 832, 600, 800, 0), 1);
  assert.equal(fitZoom('page', 632, 432, 600, 800, 0), .5);
  assert.equal(fitZoom('width', 832, 632, 600, 800, 90), 1);
  assert.equal(fitZoom('width', 1232, 832, 600, 800, 0), 2);
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
