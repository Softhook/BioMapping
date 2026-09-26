/**
 * GSRTrackManager regression: renderTrackList() must fully rebuild after a rename finishes/cancels
 *     (an "only toggle .active" shortcut left the rename input stuck open).
 *
 * Run: node --test visualiser/tests/test_track_list_render.js
 */

const test = require('node:test');
const assert = require('node:assert');

global.window = global;
global.GSR_CONST = require('../src/core/constants.mjs').GSR_CONST;
global.noLoop = () => {};
global.loop = () => {};
global.redraw = () => {};
global.windowResized = () => {};
global.requestAnimationFrame = () => {};

// ── Minimal DOM ────────────────────────────────────────────────────────────
function makeEl(tag = 'div') {
  const el = {
    tag,
    children: [],
    dataset: {},
    style: {},
    className: '',
    innerText: '',
    value: '',
    _classes: new Set(),
    classList: {
      add: (c) => el._classes.add(c),
      remove: (c) => el._classes.delete(c),
      toggle: (c, f) => (f ? el._classes.add(c) : el._classes.delete(c)),
    },
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    appendChild(c) {
      el.children.push(c);
      return c;
    },
    focus() {},
    select() {},
    querySelector(sel) {
      const cls = sel.startsWith('.') ? sel.slice(1) : null;
      const walk = (n) => {
        for (const c of n.children) {
          if (cls && c.className.split(' ').includes(cls)) return c;
          const f = walk(c);
          if (f) return f;
        }
        return null;
      };
      return walk(el);
    },
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => html,
    set: (v) => {
      html = v;
      if (v === '') el.children = [];
    },
  });
  return el;
}

const listEl = makeEl('ul');
const containerEl = makeEl();
global.document = {
  getElementById: (id) =>
    id === 'trackList'
      ? listEl
      : id === 'trackListContainer'
        ? containerEl
        : null,
  createElement: (t) => makeEl(t),
  querySelector: (sel) => {
    const m = /li\[data-track-id="(.+)"\]/.exec(sel);
    return m
      ? listEl.children.find((c) => c.dataset.trackId === m[1]) || null
      : null;
  },
};

const { GSRTrackManager } = require('../src/ui/tracks.mjs');
const { AppState } = require('../src/core/app_state.mjs');

function fakeTrack(id, name) {
  return {
    id,
    name,
    color: '#f00',
    enabled: true,
    filterParams: {},
    analyzer: { raw: [{ time: 0 }, { time: 10 }], integrity: null },
  };
}

function setup(tracks) {
  listEl.children = [];
  AppState.dropZone = makeEl();
  AppState.collectiveManager = {
    tracks,
    getTrack: (id) => tracks.find((t) => t.id === id),
  };
  AppState.activeTrackId = tracks[0].id;
  AppState.analyzer = tracks[0].analyzer;
  AppState._renamingTrackId = null;
}

test('renameTrack finish: list is rebuilt with the new name and input hidden', () => {
  const tracks = [fakeTrack('a', 'Alpha'), fakeTrack('b', 'Beta')];
  setup(tracks);
  GSRTrackManager.renderTrackList();
  const before = listEl.children[0];

  GSRTrackManager.startRenameTrack('a');
  const li = listEl.children[0];
  assert.strictEqual(li.querySelector('.track-name').style.display, 'none');

  GSRTrackManager.finishRenameTrack('a', 'Renamed');

  assert.notStrictEqual(listEl.children[0], before, 'DOM must be rebuilt');
  const fresh = listEl.children[0];
  assert.strictEqual(fresh.querySelector('.track-name').innerText, 'Renamed');
  assert.notStrictEqual(
    fresh.querySelector('.track-name').style.display,
    'none',
  );
  assert.strictEqual(
    fresh.querySelector('.track-name-input').style.display,
    'none',
  );
});

test('renameTrack cancel: list is rebuilt and the name span is visible again', () => {
  const tracks = [fakeTrack('a', 'Alpha')];
  setup(tracks);
  GSRTrackManager.renderTrackList();
  GSRTrackManager.startRenameTrack('a');
  GSRTrackManager.cancelRenameTrack();
  const fresh = listEl.children[0];
  assert.notStrictEqual(
    fresh.querySelector('.track-name').style.display,
    'none',
  );
  assert.strictEqual(
    fresh.querySelector('.track-name-input').style.display,
    'none',
  );
});

test('renderTrackList rebuilds when a track was added, removed, or reordered', () => {
  const tracks = [fakeTrack('a', 'A'), fakeTrack('b', 'B')];
  setup(tracks);
  GSRTrackManager.renderTrackList();
  assert.deepStrictEqual(
    listEl.children.map((c) => c.dataset.trackId),
    ['a', 'b'],
  );
  tracks.reverse();
  GSRTrackManager.renderTrackList();
  assert.deepStrictEqual(
    listEl.children.map((c) => c.dataset.trackId),
    ['b', 'a'],
  );
  tracks.push(fakeTrack('c', 'C'));
  GSRTrackManager.renderTrackList();
  assert.strictEqual(listEl.children.length, 3);
});
