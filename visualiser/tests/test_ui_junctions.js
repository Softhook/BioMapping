/**
 * Unit tests for ui_junctions_table.mjs and junction analysis UI rendering.
 * Run: node --test tests/test_ui_junctions.js
 */
const assert = require('node:assert');
const test = require('node:test');

const { AppState } = require('../src/core/app_state.mjs');
const { JunctionsTableUI } = require('../src/ui/ui_junctions_table.mjs');

function makeClassList() {
  const set = new Set();
  return {
    add: (...cls) => {
      for (const c of cls) set.add(c);
    },
    remove: (...cls) => {
      for (const c of cls) set.delete(c);
    },
    contains: (c) => set.has(c),
  };
}

function setupDOM() {
  const elements = new Map();
  const summaryEl = {
    id: 'junctionSummaryRow',
    innerHTML: '',
  };
  const bannerEl = {
    id: 'junctionInsightBanner',
    innerHTML: '',
    style: {},
  };
  const cardsEl = {
    id: 'junctionCardsGrid',
    innerHTML: '',
  };
  const tbodyEl = {
    children: [],
    innerHTML: '',
    appendChild(child) {
      this.children.push(child);
    },
  };
  const ths = [
    {
      dataset: { sort: 'phase' },
      classList: makeClassList(),
      querySelector: () => ({ className: '' }),
    },
    {
      dataset: { sort: 'diff' },
      classList: makeClassList(),
      querySelector: () => ({ className: '' }),
    },
    {
      dataset: { sort: 'pVal' },
      classList: makeClassList(),
      querySelector: () => ({ className: '' }),
    },
  ];
  const tableEl = {
    id: 'junctionsTable',
    querySelectorAll(sel) {
      if (sel === 'thead th.sortable') return ths;
      return [];
    },
  };

  elements.set('junctionSummaryRow', summaryEl);
  elements.set('junctionInsightBanner', bannerEl);
  elements.set('junctionCardsGrid', cardsEl);
  elements.set('junctionsTable', tableEl);

  global.document = {
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector(sel) {
      if (sel === '#junctionsTable tbody') return tbodyEl;
      return null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        innerHTML: '',
        style: {},
      };
    },
  };

  return { summaryEl, bannerEl, cardsEl, tbodyEl, ths };
}

test('renderJunctionsTable: empty stats renders appropriate notice and 0 passages', () => {
  const { summaryEl, tbodyEl } = setupDOM();
  JunctionsTableUI.renderJunctionsTable({
    passages: [],
    responses: [],
    comparison: [],
  });

  assert.ok(summaryEl.innerHTML.includes('0 total'));
  assert.strictEqual(tbodyEl.children.length, 1);
  assert.ok(
    tbodyEl.children[0].innerHTML.includes('No junction passages detected'),
  );
});

function mockRow(phase, metric, over) {
  return {
    phase,
    metric,
    nTurn: 40,
    nStraight: 100,
    nTracks: 3,
    meanTurn: 0.3,
    meanStraight: 0.25,
    diff: 0.05,
    pairedN: 0,
    test: 'pooled',
    p: 0.5,
    q: 0.8,
    verdict: 'none',
    ...over,
  };
}

const baseStats = (comparison) => ({
  passages: [
    { key: 'J1', time: 1, decision: 'turn' },
    { key: 'J1', time: 9, decision: 'straight' },
    { key: 'J2', time: 20, decision: 'straight' }, // no response -> dropped
    { key: 'J3', time: 30, decision: 'reverse' },
    { key: 'J4', time: 40, decision: 'ambiguous' },
  ],
  responses: [
    { key: 'J1', time: 1, decision: 'turn' },
    { key: 'J1', time: 9, decision: 'straight' },
  ],
  comparison,
});

test('renderJunctionsTable: counts passages, dropped windows and exclusions', () => {
  const { summaryEl } = setupDOM();
  JunctionsTableUI.renderJunctionsTable(
    baseStats([mockRow('after', 'meanPhasic', {})]),
  );
  assert.ok(summaryEl.innerHTML.includes('5 total'));
  assert.ok(summaryEl.innerHTML.includes('1 Turns'));
  assert.ok(summaryEl.innerHTML.includes('2 Straight'));
  assert.ok(
    summaryEl.innerHTML.includes(
      'no clean window: 0 of 1 turns, 1 of 2 straights',
    ),
  );
  assert.ok(summaryEl.innerHTML.includes('2 reverse/ambiguous not compared'));
});

test('renderJunctionsTable: a null result says so, and never claims an effect', () => {
  const { bannerEl, cardsEl, tbodyEl } = setupDOM();
  JunctionsTableUI.renderJunctionsTable(
    baseStats([
      mockRow('before', 'meanPhasic', {}),
      mockRow('after', 'meanPhasic', {
        meanTurn: 0.303,
        meanStraight: 0.252,
        diff: 0.051,
      }),
    ]),
  );
  assert.strictEqual(bannerEl.style.display, 'block');
  assert.ok(bannerEl.innerHTML.includes('No detectable difference'));
  assert.ok(!/increased|reduced|caused/.test(bannerEl.innerHTML));
  assert.ok(bannerEl.innerHTML.includes('not evidence of no effect'));
  assert.ok(!/caused/.test(cardsEl.innerHTML));
  assert.strictEqual(tbodyEl.children.length, 2);
  assert.ok(tbodyEl.children[1].innerHTML.includes('n.s.'));
  assert.ok(!tbodyEl.children[1].innerHTML.includes('Supported'));
});

test('renderJunctionsTable: uncorrected p<0.05 with q>=0.05 is only a weak hint', () => {
  const { bannerEl, tbodyEl } = setupDOM();
  JunctionsTableUI.renderJunctionsTable(
    baseStats([
      mockRow('before', 'meanPhasic', {
        p: 0.029,
        q: 0.196,
        verdict: 'suggestive',
        test: 'paired',
        pairedN: 8,
      }),
    ]),
  );
  assert.ok(bannerEl.innerHTML.includes('No robust difference'));
  assert.ok(tbodyEl.children[0].innerHTML.includes('Weak hint only'));
  assert.ok(!tbodyEl.children[0].innerHTML.includes('Supported'));
});

test('renderJunctionsTable: only a q<0.05 row is reported as supported', () => {
  const { bannerEl, tbodyEl } = setupDOM();
  JunctionsTableUI.renderJunctionsTable(
    baseStats([
      mockRow('before', 'meanPhasic', {}),
      mockRow('after', 'meanPhasic', {
        meanTurn: 0.6,
        meanStraight: 0.3,
        diff: 0.3,
        p: 0.001,
        q: 0.007,
        verdict: 'supported',
      }),
    ]),
  );
  assert.ok(bannerEl.innerHTML.includes('differ in 1 of 2 measures'));
  assert.ok(bannerEl.innerHTML.includes('association'));
  assert.ok(tbodyEl.children[1].innerHTML.includes('Supported (q=0.007)'));
});

test('sortJunctionsTable: toggles sort column and direction', () => {
  setupDOM();
  AppState.junctionSortColumn = null;
  AppState.junctionSortDirection = 'asc';

  JunctionsTableUI.sortJunctionsTable('diff');
  assert.strictEqual(AppState.junctionSortColumn, 'diff');
  assert.strictEqual(AppState.junctionSortDirection, 'desc');

  JunctionsTableUI.sortJunctionsTable('diff');
  assert.strictEqual(AppState.junctionSortColumn, 'diff');
  assert.strictEqual(AppState.junctionSortDirection, 'asc');
});

test('renderJunctionsTable: percentages are hidden on null rows and near-zero baselines', () => {
  AppState.junctionSortColumn = null;
  const { cardsEl, tbodyEl } = setupDOM();
  JunctionsTableUI.renderJunctionsTable(
    baseStats([
      mockRow('after', 'meanPhasic', {
        meanTurn: 0.6,
        meanStraight: 0.05,
        diff: 0.55,
      }),
      mockRow('before', 'meanPhasic', {
        meanTurn: 0.6,
        meanStraight: 0.3,
        diff: 0.3,
        p: 0.001,
        q: 0.004,
        verdict: 'supported',
      }),
    ]),
  );
  assert.ok(!/%\)/.test(tbodyEl.children[0].innerHTML));
  assert.ok(/\(\+100%\)/.test(tbodyEl.children[1].innerHTML));
  assert.ok(!/\+1100%/.test(cardsEl.innerHTML));
});

test('renderJunctionsTable: per-class dropped counts and an uneven-loss warning', () => {
  const { summaryEl } = setupDOM();
  const passages = [];
  const responses = [];
  for (let i = 0; i < 10; i++)
    passages.push({ key: `T${i}`, time: i, decision: 'turn' });
  for (let i = 0; i < 10; i++)
    passages.push({ key: `S${i}`, time: i, decision: 'straight' });
  for (let i = 0; i < 8; i++)
    responses.push({ key: `S${i}`, time: i, decision: 'straight' });
  responses.push({ key: 'T0', time: 0, decision: 'turn' });
  JunctionsTableUI.renderJunctionsTable({
    passages,
    responses,
    comparison: [mockRow('after', 'meanPhasic', {})],
  });
  assert.ok(summaryEl.innerHTML.includes('9 of 10 turns, 2 of 10 straights'));
  assert.ok(summaryEl.innerHTML.includes('Uneven loss'));
});

test('renderJunctionsTable: never shows a percentage on a change (delta) row', () => {
  AppState.junctionSortColumn = null;
  const { tbodyEl } = setupDOM();
  JunctionsTableUI.renderJunctionsTable(
    baseStats([
      mockRow('delta', 'meanPhasic', {
        meanTurn: 0.9,
        meanStraight: 0.3,
        diff: 0.6,
        p: 0.001,
        q: 0.004,
        verdict: 'supported',
      }),
    ]),
  );
  assert.ok(!/%\)/.test(tbodyEl.children[0].innerHTML));
});
