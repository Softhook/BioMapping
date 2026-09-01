/**
 * Tests for Skin Conductance Response (SCR) Events table column sorting.
 * Verifies sorting by No./index, label, amplitude, rise time, quality, and exclusion status,
 * ensuring UI header indicators and row event bindings remain accurate and non-destructive.
 */

const assert = require('assert');
const test = require('node:test');
const { bootApp } = require('./support/boot_app.js');

function createSampleAnalyzer() {
  return {
    raw: [
      { time: 0, gsr: 2.0, hasGps: true, lat: 51.5, lon: -0.1 },
      { time: 10, gsr: 3.5, hasGps: true, lat: 51.501, lon: -0.101 },
      { time: 20, gsr: 2.2, hasGps: true, lat: 51.502, lon: -0.102 },
      { time: 30, gsr: 4.1, hasGps: true, lat: 51.503, lon: -0.103 },
      { time: 40, gsr: 2.5, hasGps: true, lat: 51.504, lon: -0.104 }
    ],
    peaks: [
      {
        index: 1,
        time: 10,
        onsetTime: 8,
        amplitude: 1.5,
        riseTime: 2.0,
        qualityScore: 85,
        excluded: false,
        label: 'Traffic shock'
      },
      {
        index: 3,
        time: 30,
        onsetTime: 26,
        amplitude: 2.8,
        riseTime: 4.0,
        qualityScore: 95,
        excluded: false,
        label: 'Barking dog'
      },
      {
        index: 4,
        time: 40,
        onsetTime: 39,
        amplitude: 0.4,
        riseTime: 1.0,
        qualityScore: 60,
        excluded: true,
        label: 'Acoustic siren'
      }
    ],
    getCoordinates(idx) {
      return { lat: 51.5 + idx * 0.001, lon: -0.1 - idx * 0.001 };
    },
    findClosestIndex(t) {
      if (!this.raw || this.raw.length === 0) return -1;
      let closest = 0;
      let minDiff = Math.abs(this.raw[0].time - t);
      for (let i = 1; i < this.raw.length; i++) {
        const diff = Math.abs(this.raw[i].time - t);
        if (diff < minDiff) {
          minDiff = diff;
          closest = i;
        }
      }
      return closest;
    },
    setPeakExcluded(idx, excluded) {
      if (this.peaks[idx]) this.peaks[idx].excluded = excluded;
    }
  };
}

test('peaks table renders empty row when no peaks detected', () => {
  const { window } = bootApp();
  window.setup();
  window.AppState.analyzer = { peaks: [] };

  window.GSRUI.updatePeaksTable();
  const rows = window.document.querySelectorAll('#peaksTable tbody tr');
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].classList.contains('empty-row'));
});

test('peaks table renders in default chronological index order', () => {
  const { window } = bootApp();
  window.setup();
  window.AppState.analyzer = createSampleAnalyzer();
  window.AppState.peakSortColumn = 'index';
  window.AppState.peakSortDirection = 'asc';

  window.GSRUI.updatePeaksTable();
  const rows = window.document.querySelectorAll('#peaksTable tbody tr');
  assert.strictEqual(rows.length, 3);

  // First row: Peak 1 (orig index 0, amplitude 1.5)
  assert.strictEqual(rows[0].id, 'peakRow-0');
  assert.strictEqual(rows[0].children[0].textContent, '1');
  assert.ok(rows[0].children[1].querySelector('textarea').value.includes('Traffic shock'));

  // Second row: Peak 2 (orig index 1, amplitude 2.8)
  assert.strictEqual(rows[1].id, 'peakRow-1');
  assert.strictEqual(rows[1].children[0].textContent, '2');

  // Third row: Peak 3 (orig index 2, amplitude 0.4)
  assert.strictEqual(rows[2].id, 'peakRow-2');
  assert.strictEqual(rows[2].children[0].textContent, '3');
});

test('sorting peaks table by amplitude ascending and descending', () => {
  const { window } = bootApp();
  window.setup();
  window.AppState.analyzer = createSampleAnalyzer();

  // Sort by amplitude ascending
  window.GSRUI.sortPeaksTable('amplitude');
  assert.strictEqual(window.AppState.peakSortColumn, 'amplitude');
  assert.strictEqual(window.AppState.peakSortDirection, 'asc');

  let rows = window.document.querySelectorAll('#peaksTable tbody tr');
  // Order: 0.4 (Peak 3, orig index 2), 1.5 (Peak 1, orig index 0), 2.8 (Peak 2, orig index 1)
  assert.strictEqual(rows[0].id, 'peakRow-2');
  assert.strictEqual(rows[0].children[0].textContent, '3'); // Shows original peak number #3
  assert.strictEqual(rows[0].children[2].textContent, '0.4000');

  assert.strictEqual(rows[1].id, 'peakRow-0');
  assert.strictEqual(rows[1].children[0].textContent, '1');
  assert.strictEqual(rows[1].children[2].textContent, '1.5000');

  assert.strictEqual(rows[2].id, 'peakRow-1');
  assert.strictEqual(rows[2].children[0].textContent, '2');
  assert.strictEqual(rows[2].children[2].textContent, '2.8000');

  // Second click toggles to descending
  window.GSRUI.sortPeaksTable('amplitude');
  assert.strictEqual(window.AppState.peakSortColumn, 'amplitude');
  assert.strictEqual(window.AppState.peakSortDirection, 'desc');

  rows = window.document.querySelectorAll('#peaksTable tbody tr');
  // Order: 2.8 (orig index 1), 1.5 (orig index 0), 0.4 (orig index 2)
  assert.strictEqual(rows[0].id, 'peakRow-1');
  assert.strictEqual(rows[0].children[2].textContent, '2.8000');
  assert.strictEqual(rows[1].id, 'peakRow-0');
  assert.strictEqual(rows[1].children[2].textContent, '1.5000');
  assert.strictEqual(rows[2].id, 'peakRow-2');
  assert.strictEqual(rows[2].children[2].textContent, '0.4000');
});

test('sorting peaks table by label (alphabetical)', () => {
  const { window } = bootApp();
  window.setup();
  window.AppState.analyzer = createSampleAnalyzer();

  window.GSRUI.sortPeaksTable('label');
  assert.strictEqual(window.AppState.peakSortColumn, 'label');
  assert.strictEqual(window.AppState.peakSortDirection, 'asc');

  let rows = window.document.querySelectorAll('#peaksTable tbody tr');
  // Order: Acoustic siren (orig 2), Barking dog (orig 1), Traffic shock (orig 0)
  assert.strictEqual(rows[0].id, 'peakRow-2');
  assert.strictEqual(rows[1].id, 'peakRow-1');
  assert.strictEqual(rows[2].id, 'peakRow-0');

  // Descending
  window.GSRUI.sortPeaksTable('label');
  rows = window.document.querySelectorAll('#peaksTable tbody tr');
  assert.strictEqual(rows[0].id, 'peakRow-0');
  assert.strictEqual(rows[1].id, 'peakRow-1');
  assert.strictEqual(rows[2].id, 'peakRow-2');
});

test('sorting peaks table by rise time', () => {
  const { window } = bootApp();
  window.setup();
  window.AppState.analyzer = createSampleAnalyzer();

  window.GSRUI.sortPeaksTable('riseTime');
  assert.strictEqual(window.AppState.peakSortColumn, 'riseTime');
  assert.strictEqual(window.AppState.peakSortDirection, 'asc');

  const rows = window.document.querySelectorAll('#peaksTable tbody tr');
  // Rise times: 1.0 (orig 2), 2.0 (orig 0), 4.0 (orig 1)
  assert.strictEqual(rows[0].id, 'peakRow-2');
  assert.strictEqual(rows[1].id, 'peakRow-0');
  assert.strictEqual(rows[2].id, 'peakRow-1');
});

test('sorting peaks table by quality score', () => {
  const { window } = bootApp();
  window.setup();
  window.AppState.analyzer = createSampleAnalyzer();

  window.GSRUI.sortPeaksTable('quality');
  let rows = window.document.querySelectorAll('#peaksTable tbody tr');
  // Quality: 60 (orig 2), 85 (orig 0), 95 (orig 1)
  assert.strictEqual(rows[0].id, 'peakRow-2');
  assert.strictEqual(rows[1].id, 'peakRow-0');
  assert.strictEqual(rows[2].id, 'peakRow-1');

  // Descending
  window.GSRUI.sortPeaksTable('quality');
  rows = window.document.querySelectorAll('#peaksTable tbody tr');
  assert.strictEqual(rows[0].id, 'peakRow-1');
  assert.strictEqual(rows[1].id, 'peakRow-0');
  assert.strictEqual(rows[2].id, 'peakRow-2');
});

test('sorting peaks table by exclusion status', () => {
  const { window } = bootApp();
  window.setup();
  window.AppState.analyzer = createSampleAnalyzer();

  window.GSRUI.sortPeaksTable('excluded');
  const rows = window.document.querySelectorAll('#peaksTable tbody tr');
  // Not excluded first: orig 0, orig 1, then excluded orig 2
  assert.strictEqual(rows[0].id, 'peakRow-0');
  assert.strictEqual(rows[1].id, 'peakRow-1');
  assert.strictEqual(rows[2].id, 'peakRow-2');
});

test('table headers update sort classes and icons on click', () => {
  const { window } = bootApp();
  window.setup();
  window.AppState.analyzer = createSampleAnalyzer();

  const doc = window.document;
  const thAmp = doc.querySelector('th[data-sort="amplitude"]');
  const thLabel = doc.querySelector('th[data-sort="label"]');

  assert.ok(thAmp && thLabel);

  // Click Amplitude
  thAmp.click();
  assert.strictEqual(window.AppState.peakSortColumn, 'amplitude');
  assert.strictEqual(window.AppState.peakSortDirection, 'asc');
  assert.ok(thAmp.classList.contains('sort-asc'));
  assert.ok(thAmp.querySelector('.sort-icon').classList.contains('fa-sort-up'));
  assert.ok(!thLabel.classList.contains('sort-asc'));

  // Click Amplitude again (toggle desc)
  thAmp.click();
  assert.strictEqual(window.AppState.peakSortDirection, 'desc');
  assert.ok(thAmp.classList.contains('sort-desc'));
  assert.ok(thAmp.querySelector('.sort-icon').classList.contains('fa-sort-down'));

  // Click Label
  thLabel.click();
  assert.strictEqual(window.AppState.peakSortColumn, 'label');
  assert.strictEqual(window.AppState.peakSortDirection, 'asc');
  assert.ok(thLabel.classList.contains('sort-asc'));
  assert.ok(!thAmp.classList.contains('sort-asc') && !thAmp.classList.contains('sort-desc'));
  assert.ok(thAmp.querySelector('.sort-icon').classList.contains('fa-sort'));
});

test('sorted table actions and inputs target the correct original peak index', () => {
  const { window } = bootApp();
  window.setup();
  const analyzer = createSampleAnalyzer();
  window.AppState.analyzer = analyzer;

  // Sort by amplitude descending (Peak 2 [orig 1] is first)
  window.GSRUI.sortPeaksTable('amplitude');
  window.GSRUI.sortPeaksTable('amplitude');

  let rows = window.document.querySelectorAll('#peaksTable tbody tr');
  let firstRow = rows[0]; // Represents Peak 2 (orig idx 1)
  assert.strictEqual(firstRow.id, 'peakRow-1');
  assert.ok(firstRow.getAttribute('onclick').includes("GSRUI.focusOnPeak(1, 'table')"));

  // Verify textarea data attribute and value
  const textarea = firstRow.querySelector('.peak-label-input');
  assert.strictEqual(textarea.dataset.peakIdx, '1');
  assert.strictEqual(textarea.value.trim(), 'Barking dog');

  // Live label editing updates peak 1
  window.GSRUI.handleLiveLabelInput(1, 'Updated dog label');
  assert.strictEqual(analyzer.peaks[1].label, 'Updated dog label');

  // Exclusion button targets peak 1
  assert.strictEqual(analyzer.peaks[1].excluded, false);
  const excludeBtn = firstRow.querySelector('.btn-exclude');
  assert.ok(excludeBtn.getAttribute('onclick').includes("GSRUI.togglePeakExclusion(1)"));
  window.GSRUI.togglePeakExclusion(1);
  assert.strictEqual(analyzer.peaks[1].excluded, true);

  // View button targets peak 1
  const activeRow = window.document.getElementById('peakRow-1');
  assert.ok(activeRow);
  const viewBtn = activeRow.querySelector('.btn-table-action');
  assert.ok(viewBtn.getAttribute('onclick').includes("GSRUI.focusOnPeak(1, 'table')"));

  // Calling focusOnPeak with peak 1 activates the row and view window
  window.GSRUI.focusOnPeak(1, 'table');
  assert.strictEqual(window.AppState.activePeakIndex, 1);
  assert.ok(activeRow.classList.contains('active-row'));
});
