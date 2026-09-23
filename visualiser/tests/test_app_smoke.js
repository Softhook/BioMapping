/**
 * App-level smoke tests: boots the real app (see tests/support/boot_app.js
 * for how — real index.html DOM, every real source file unmodified, Leaflet/
 * p5/JSZip stubbed) and exercises the core user-facing flows end to end,
 * checking that nothing throws and that AppState ends up in the expected
 * shape. This is deliberately breadth-over-depth: it does NOT try to unit-
 * test every function in the DOM/Leaflet/p5 rendering layer (map.js, ui.js,
 * events.js, sketch.js, layout_manager.js) — see
 * docs/archive/visualizer_test_coverage_plan.md for why that's out of scope and
 * tests/support/boot_app.js's header comment for exactly what these tests
 * can and can't catch.
 *
 * Run: node --test tests/test_app_smoke.js
 */

const assert = require('node:assert');
const test = require('node:test');
const { bootApp } = require('./support/boot_app.js');

const SAMPLE_CSV = [
  'timestamp,lat,lon,hdop,pdop,sats,fix_type,speed_kts,course_deg,gsr_raw,hacc_m',
  '0.0,51.5074,-0.1278,1.0,1.5,8,3,0.5,90,10000,3.0',
  '0.1,51.5075,-0.1277,1.0,1.5,8,3,0.5,90,10500,3.0',
  '0.2,51.5076,-0.1276,1.0,1.5,8,3,0.5,90,15000,3.0',
  '0.3,51.5077,-0.1275,1.0,1.5,8,3,0.5,90,10200,3.0',
  '0.4,51.5078,-0.1274,1.0,1.5,8,3,0.5,90,10100,3.0',
].join('\n');

// Minimal synchronous FileReader-like stand-in, matching the pattern already
// established in tests/test_tracks.js for feeding CSV text through the real
// handleIncomingFiles()/loadFilesSequentially() code path without a real
// browser File/FileReader (neither exists in Node).
function makeFakeFile(name, text) {
  return { name, _text: text };
}
function installFakeFileReader(window) {
  window.FileReader = class {
    readAsText(file) {
      setTimeout(() => {
        this.result = file._text;
        if (this.onload) this.onload({ target: this });
      }, 0);
    }
  };
}

test('app boots via setup() without throwing, and wires up AppState', async () => {
  const { window } = await bootApp();
  assert.doesNotThrow(() => window.setup());
  assert.ok(
    window.AppState.analyzer,
    'AppState.analyzer should be constructed',
  );
  assert.ok(
    window.AppState.collectiveManager,
    'AppState.collectiveManager should be constructed',
  );
  assert.ok(
    window.AppState.mapManager,
    'AppState.mapManager should be constructed',
  );
});

test('windowResized() runs without throwing after boot', async () => {
  const { window } = await bootApp();
  window.setup();
  assert.doesNotThrow(() => window.windowResized());
});

test('loading a track via the real file-drop pipeline adds it to AppState.collectiveManager', async () => {
  const { window } = await bootApp();
  installFakeFileReader(window);
  window.setup();

  const file = makeFakeFile('track1.csv', SAMPLE_CSV);
  await new Promise((resolve, reject) => {
    try {
      window.GSRTrackManager.loadFilesSequentially([file]);
      // loadFilesSequentially is internally async (FileReader-driven); poll
      // briefly for the track to land rather than assuming synchronous completion.
      const start = Date.now();
      const check = () => {
        if (window.AppState.collectiveManager.tracks.length > 0)
          return resolve();
        if (Date.now() - start > 2000)
          return reject(new Error('track never loaded within 2s'));
        setTimeout(check, 10);
      };
      check();
    } catch (e) {
      reject(e);
    }
  });

  assert.strictEqual(window.AppState.collectiveManager.tracks.length, 1);
  const track = window.AppState.collectiveManager.tracks[0];
  assert.strictEqual(track.name, 'track1.csv');
  assert.ok(
    track.analyzer.filtered && track.analyzer.filtered.length > 0,
    'the loaded track should have been analyzed',
  );
});

test('loading a track while in collective view mode refreshes the collective map (via switchActiveTrack -> runAnalysis, not a separate call)', async () => {
  const { window, document } = await bootApp();
  installFakeFileReader(window);
  window.setup();

  document
    .getElementById('btnCollectiveView')
    .dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.strictEqual(window.AppState.viewMode, 'collective');

  let updateCalls = 0;
  const original = window.GSRUI.updateCollectiveMap;
  window.GSRUI.updateCollectiveMap = (...args) => {
    updateCalls++;
    return original.apply(window.GSRUI, args);
  };

  await new Promise((resolve, reject) => {
    window.GSRTrackManager.loadFilesSequentially([
      makeFakeFile('track1.csv', SAMPLE_CSV),
    ]);
    const start = Date.now();
    const check = () => {
      if (window.AppState.collectiveManager.tracks.length > 0) return resolve();
      if (Date.now() - start > 2000)
        return reject(new Error('track never loaded within 2s'));
      setTimeout(check, 10);
    };
    check();
  });

  window.GSRUI.updateCollectiveMap = original;
  assert.ok(
    updateCalls > 0,
    'updateCollectiveMap should have been triggered by the trackAdded listener',
  );
});

test('Deconvolution and Prominence detector toggles are mutually exclusive via the real wired-up DOM', async () => {
  const { window, document } = await bootApp();
  installFakeFileReader(window);
  window.setup();

  await new Promise((resolve, reject) => {
    window.GSRTrackManager.loadFilesSequentially([
      makeFakeFile('track1.csv', SAMPLE_CSV),
    ]);
    const start = Date.now();
    const check = () => {
      if (window.AppState.collectiveManager.tracks.length > 0) return resolve();
      if (Date.now() - start > 2000)
        return reject(new Error('track never loaded within 2s'));
      setTimeout(check, 10);
    };
    check();
  });

  const decon = document.getElementById('useDeconvolution');
  const prom = document.getElementById('usePeakProminence');
  const fireChange = (el) =>
    el.dispatchEvent(new window.Event('change', { bubbles: true }));

  // Turn Deconvolution on.
  decon.checked = true;
  assert.doesNotThrow(() => fireChange(decon));
  assert.strictEqual(decon.checked, true);
  assert.strictEqual(prom.checked, false);

  // Turn Prominence on — Deconvolution must switch off.
  prom.checked = true;
  assert.doesNotThrow(() => fireChange(prom));
  assert.strictEqual(prom.checked, true);
  assert.strictEqual(
    decon.checked,
    false,
    'enabling Prominence disables Deconvolution',
  );

  // Turn Deconvolution back on — Prominence must switch off.
  decon.checked = true;
  assert.doesNotThrow(() => fireChange(decon));
  assert.strictEqual(decon.checked, true);
  assert.strictEqual(
    prom.checked,
    false,
    'enabling Deconvolution disables Prominence',
  );

  // Turn Deconvolution off — neither is on (default trough-to-peak).
  decon.checked = false;
  assert.doesNotThrow(() => fireChange(decon));
  assert.strictEqual(decon.checked, false);
  assert.strictEqual(prom.checked, false);
});

test('the "Driver (ISCR)" graph view is enabled only while a deconvolution/cvxEDA detector is active', async () => {
  const { window, document } = await bootApp();
  installFakeFileReader(window);
  window.setup();

  await new Promise((resolve, reject) => {
    window.GSRTrackManager.loadFilesSequentially([
      makeFakeFile('track1.csv', SAMPLE_CSV),
    ]);
    const start = Date.now();
    const check = () => {
      if (window.AppState.collectiveManager.tracks.length > 0) return resolve();
      if (Date.now() - start > 2000)
        return reject(new Error('track never loaded within 2s'));
      setTimeout(check, 10);
    };
    check();
  });

  const graphView = document.getElementById('graphView');
  const driverOpt = graphView.querySelector('option[value="phasicDriver"]');
  const decon = document.getElementById('useDeconvolution');
  const fireChange = (el) =>
    el.dispatchEvent(new window.Event('change', { bubbles: true }));

  assert.ok(driverOpt, 'the #graphView dropdown has a phasicDriver option');
  assert.strictEqual(
    driverOpt.disabled,
    true,
    'disabled by default (no deconvolution driver yet)',
  );

  // Enable deconvolution → a driver series is produced → the option unlocks.
  // (The toggle handler yields a frame so the busy spinner can paint first.)
  const settle = () => new Promise((r) => setTimeout(r, 120));
  decon.checked = true;
  fireChange(decon);
  await settle();
  assert.strictEqual(
    driverOpt.disabled,
    false,
    'enabled once deconvolution populates analyzer.phasicDriver',
  );

  // Select it, then turn the detector back off: the view must fall back to
  // 'signal' rather than plotting an empty series, and the option re-locks.
  graphView.value = 'phasicDriver';
  fireChange(graphView);
  assert.strictEqual(window.AppState.graphView, 'phasicDriver');

  decon.checked = false;
  fireChange(decon);
  await settle();
  assert.strictEqual(
    driverOpt.disabled,
    true,
    're-locked when no detector produces a driver',
  );
  assert.strictEqual(
    graphView.value,
    'signal',
    'selection dropped back to Signal',
  );
  assert.strictEqual(window.AppState.graphView, 'signal');
});

test('deleteTrack removes the track and leaves a clean, consistent AppState', async () => {
  const { window } = await bootApp();
  installFakeFileReader(window);
  window.setup();

  await new Promise((resolve, reject) => {
    window.GSRTrackManager.loadFilesSequentially([
      makeFakeFile('track1.csv', SAMPLE_CSV),
    ]);
    const start = Date.now();
    const check = () => {
      if (window.AppState.collectiveManager.tracks.length > 0) return resolve();
      if (Date.now() - start > 2000)
        return reject(new Error('track never loaded within 2s'));
      setTimeout(check, 10);
    };
    check();
  });

  const trackId = window.AppState.collectiveManager.tracks[0].id;
  assert.doesNotThrow(() => window.GSRTrackManager.deleteTrack(trackId));
  assert.strictEqual(window.AppState.collectiveManager.tracks.length, 0);
  assert.strictEqual(window.AppState.activeTrackId, null);
});

test('toggling view mode (single <-> collective) via the real wired-up DOM buttons preserves viewport without refitting', async () => {
  const { window, document } = await bootApp();
  installFakeFileReader(window);
  window.setup();

  await new Promise((resolve, reject) => {
    window.GSRTrackManager.loadFilesSequentially([
      makeFakeFile('track1.csv', SAMPLE_CSV),
    ]);
    const start = Date.now();
    const check = () => {
      if (window.AppState.collectiveManager.tracks.length > 0) return resolve();
      if (Date.now() - start > 2000)
        return reject(new Error('track never loaded within 2s'));
      setTimeout(check, 10);
    };
    check();
  });

  const collectiveBtn = document.getElementById('btnCollectiveView');
  const singleBtn = document.getElementById('btnSingleView');
  assert.ok(
    collectiveBtn,
    'btnCollectiveView should exist in the real index.html markup',
  );
  assert.ok(
    singleBtn,
    'btnSingleView should exist in the real index.html markup',
  );

  let invalidates = 0;
  let fitCalls = 0;
  window.AppState.mapManager.map.invalidateSize = (opts) => {
    invalidates++;
    assert.strictEqual(
      opts?.pan,
      false,
      'invalidateSize should be called with pan: false on mode switch',
    );
  };
  window.AppState.mapManager.map.flyToBounds = () => {
    fitCalls++;
  };
  window.AppState.mapManager.map.fitBounds = () => {
    fitCalls++;
  };

  // Switching to collective mode should NOT refit the viewport (map data stays in place)
  collectiveBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.strictEqual(window.AppState.viewMode, 'collective');
  assert.strictEqual(
    fitCalls,
    0,
    'Switching to collective mode must not re-fit viewport',
  );
  assert.ok(
    invalidates >= 1,
    'map.invalidateSize should run synchronously on collective mode switch',
  );

  // Switching back to single mode should NOT refit the viewport
  singleBtn.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.strictEqual(window.AppState.viewMode, 'single');
  assert.strictEqual(
    fitCalls,
    0,
    'Switching to single mode must not re-fit viewport',
  );
  assert.ok(
    invalidates >= 2,
    'map.invalidateSize should run synchronously on single mode switch',
  );
});

test('GSRCollectiveProject.exportProject() with a loaded track completes successfully (regression test for a fixed bug: suggestedName used to be referenced undeclared, crashing every export)', async () => {
  const { window } = await bootApp();
  installFakeFileReader(window);
  window.setup();

  await new Promise((resolve, reject) => {
    window.GSRTrackManager.loadFilesSequentially([
      makeFakeFile('track1.csv', SAMPLE_CSV),
    ]);
    const start = Date.now();
    const check = () => {
      if (window.AppState.collectiveManager.tracks.length > 0) return resolve();
      if (Date.now() - start > 2000)
        return reject(new Error('track never loaded within 2s'));
      setTimeout(check, 10);
    };
    check();
  });

  let alertMsg = null;
  window.alert = (msg) => {
    alertMsg = msg;
  };
  await assert.doesNotReject(window.GSRCollectiveProject.exportProject());
  assert.strictEqual(
    alertMsg,
    null,
    `export should succeed without an error alert, got: ${alertMsg}`,
  );
});

// ── Collective view: each track keeps its own settings ────────────────────
// Two walks whose CSVs carry different GSR + GPS settings.
const csvWith = (gsr, gps) =>
  `# FilterParams:${JSON.stringify(gsr)}\n# GpsFilterParams:${JSON.stringify(gps)}\n${SAMPLE_CSV}`;
const ANNA = csvWith(
  { peakThreshold: 0.2, shapeMinSnr: 4 },
  { peakLatency: 1.0, placeMergeDistance: 20, maxSpeed: 2.0 },
);
const BEN = csvWith(
  { peakThreshold: 0.045, shapeMinSnr: 2.5 },
  { peakLatency: 3.0, placeMergeDistance: 80, maxSpeed: 6.0 },
);

async function bootWithAnnaAndBen() {
  const { window, document } = await bootApp();
  installFakeFileReader(window);
  window.setup();
  await new Promise((resolve, reject) => {
    window.GSRTrackManager.loadFilesSequentially([
      makeFakeFile('anna.csv', ANNA),
      makeFakeFile('ben.csv', BEN),
    ]);
    const start = Date.now();
    const check = () => {
      if (window.AppState.collectiveManager.tracks.length === 2)
        return resolve();
      if (Date.now() - start > 2000)
        return reject(new Error('tracks never loaded within 2s'));
      setTimeout(check, 10);
    };
    check();
  });
  const [anna, ben] = window.AppState.collectiveManager.tracks;
  const click = (id) =>
    document.getElementById(id).dispatchEvent(new window.Event('click'));
  return { window, document, anna, ben, click };
}

test("collective view: clicking tracks never overwrites another track's GSR settings; each analyses with its own", async () => {
  const { window, anna, ben, click } = await bootWithAnnaAndBen();
  click('btnCollectiveView');

  const seen = new Map();
  for (const t of [anna, ben]) {
    const orig = t.analyzer.analyze.bind(t.analyzer);
    t.analyzer.analyze = (params, pl) => {
      seen.set(t, params.peakThreshold);
      return orig(params, pl);
    };
  }

  window.GSRTrackManager.switchActiveTrack(ben.id);
  window.GSRTrackManager.switchActiveTrack(anna.id);
  window.GSRTrackManager.switchActiveTrack(ben.id);

  assert.strictEqual(anna.filterParams.peakThreshold, 0.2);
  assert.strictEqual(anna.filterParams.shapeMinSnr, 4);
  assert.strictEqual(ben.filterParams.peakThreshold, 0.045);
  assert.strictEqual(
    seen.get(anna),
    0.2,
    'Anna analysed with her own threshold',
  );
  assert.strictEqual(
    seen.get(ben),
    0.045,
    'Ben analysed with his own threshold',
  );
});

test("collective view: Places sliders are Collective view's own setting — no walk's is changed, and each view keeps its own", async () => {
  const { window, document, anna, ben, click } = await bootWithAnnaAndBen();
  const slider = document.getElementById('placeMergeDistance');
  const annaOwn = anna.gpsFilterParams.placeMergeDistance;
  const benOwn = ben.gpsFilterParams.placeMergeDistance;
  click('btnCollectiveView');

  slider.value = '55';
  slider.dispatchEvent(new window.Event('input'));
  await new Promise((r) => setTimeout(r, 50)); // rafCoalesce

  assert.strictEqual(window.AppState.collectivePlaces.placeMergeDistance, 55);
  assert.strictEqual(anna.gpsFilterParams.placeMergeDistance, annaOwn);
  assert.strictEqual(ben.gpsFilterParams.placeMergeDistance, benOwn);

  window.GSRTrackManager.switchActiveTrack(anna.id);
  assert.strictEqual(slider.value, '55', 'not reset by a click');

  // Single view shows the open walk's own value; back in Collective, its own.
  click('btnSingleView');
  assert.strictEqual(slider.value, String(annaOwn));
  click('btnCollectiveView');
  assert.strictEqual(slider.value, '55');
});

test('collective view: unrelated actions (map re-render) do not push collective values onto tracks', async () => {
  const { window, anna, ben, click } = await bootWithAnnaAndBen();
  click('btnCollectiveView');
  window.GSRTrackManager.switchActiveTrack(anna.id);
  window.GSRUI.rerenderMap();
  window.GSRTrackManager.saveActiveGpsParams();
  assert.strictEqual(anna.gpsFilterParams.peakLatency, 1.0);
  assert.strictEqual(ben.gpsFilterParams.peakLatency, 3.0);
});

test("returning to Single view restores the active track's own settings into the sliders", async () => {
  const { window, document, anna, click } = await bootWithAnnaAndBen();
  click('btnCollectiveView');
  window.GSRTrackManager.switchActiveTrack(anna.id);
  click('btnSingleView');
  assert.strictEqual(document.getElementById('peakThreshold').value, '0.2');
  assert.strictEqual(document.getElementById('gpsPeakLatency').value, '1');
  assert.strictEqual(document.getElementById('placeMergeDistance').value, '20');
  assert.strictEqual(anna.filterParams.peakThreshold, 0.2);
});

test('collective view: no walk is selected; clicking one zooms the map to it without selecting or re-analysing', async () => {
  const { window, document, anna, ben, click } = await bootWithAnnaAndBen();
  const singleViewTrack = window.AppState.activeTrackId;
  click('btnCollectiveView');

  assert.strictEqual(
    document.querySelectorAll('#trackList .track-item.active').length,
    0,
    'no highlighted walk in collective view',
  );

  const zoomed = [];
  window.AppState.mapManager.zoomToTrack = (t) => {
    zoomed.push(t);
    return true;
  };
  let analyses = 0;
  for (const t of [anna, ben]) {
    const orig = t.analyzer.analyze.bind(t.analyzer);
    t.analyzer.analyze = (...a) => {
      analyses++;
      return orig(...a);
    };
  }
  const row = [...document.querySelectorAll('#trackList .track-item')].find(
    (li) => li.dataset.trackId === ben.id,
  );
  row.querySelector('.track-details').dispatchEvent(new window.Event('click'));

  assert.deepStrictEqual(zoomed, [ben], 'map zoomed to the clicked walk');
  assert.strictEqual(window.AppState.activeTrackId, singleViewTrack);
  assert.strictEqual(analyses, 0, 'a click does not re-analyse anything');

  click('btnSingleView');
  const active = document.querySelectorAll('#trackList .track-item.active');
  assert.strictEqual(active.length, 1, 'Single view shows its walk again');
  assert.strictEqual(active[0].dataset.trackId, singleViewTrack);
});

test('collective view: radius/snap re-enrichment checks every walk for OSM data, not a hidden selection', async () => {
  const { window, anna, ben, click } = await bootWithAnnaAndBen();
  click('btnCollectiveView');
  const other = window.AppState.activeTrackId === anna.id ? ben : anna;
  assert.strictEqual(window.GSRUI.hasOsmData(), false);
  other.analyzer.osmJson = { elements: [] };
  assert.strictEqual(window.GSRUI.hasOsmData(), true);
});

test('collective view: each walk is analysed and placed with its own peak latency', async () => {
  const { window, anna, ben, click } = await bootWithAnnaAndBen();
  const seen = new Map();
  for (const t of [anna, ben]) {
    const orig = t.analyzer.analyze.bind(t.analyzer);
    t.analyzer.analyze = (params, pl) => {
      seen.set(t, pl);
      return orig(params, pl);
    };
  }
  click('btnCollectiveView');
  window.GSRUI.runAnalysis();
  assert.strictEqual(seen.get(anna), 1.0);
  assert.strictEqual(seen.get(ben), 3.0);
  const mm = window.AppState.mapManager;
  assert.strictEqual(mm._trackPeakLatency(anna), 1.0);
  assert.strictEqual(mm._trackPeakLatency(ben), 3.0);
});
