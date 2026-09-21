/**
 * Junction-response diagnostic on a real project bundle (default
 * tracks/Stokey.zip, or any list of track CSVs / zips from ONE area — the OSM
 * fetch covers their union bounding box). Identical CSVs are loaded once. Not a regression test (no assertions) — a measurement
 * script, following the `_probe_*.js` convention in this directory. Run:
 *
 *   node tests/manual/_probe_junction_response.js [project.zip | a.csv b.csv ...]
 *
 * It runs the same code path the Junction Turns tab uses (analysisSnap →
 * Junctions.classifyPassages → JunctionResponse.responses) and prints:
 *
 *   1. Before/after/change per decision (turn / straight / control) at latency
 *      0 s and at the 2 s default, with standard errors, next to a "random
 *      time" null. Use it to see whether an apparent junction effect is shared
 *      by the control (i.e. an artefact of how windows or controls are chosen).
 *   2. Traversal length (entry → exit) distribution — long tails mean merged
 *      clusters that MAX_TRAVERSAL_S drops.
 *   3. Event-locked averages (mean phasic, peak rate, speed) in 2 s bins from
 *      −30 s to +30 s around the passage, for each decision, plus an "iso"
 *      subset with no other passage within 30 s. This shows WHEN the response
 *      lands relative to the junction, which is what the window boundaries
 *      have to match.
 *
 * Caveats: needs network the first time (one Overpass request for the union
 * bbox, cached under tests/manual/.cache/); the "random time" null includes
 * stationary periods (mean speed ≈ 0.2 m/s), so it is NOT a like-for-like
 * baseline — the controls are the on-road baseline.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const JSZip = require(path.join(ROOT, 'vendor/jszip/jszip.min.js'));
const { boot } = require('./bench/harness.js');
const { OSMEnricher } = require(path.join(ROOT, 'src/osm/osm_enrichment.mjs'));
const { Junctions } = require(path.join(ROOT, 'src/gps/junctions.mjs'));
const { JunctionResponse } = require(
  path.join(ROOT, 'src/gps/junction_response.mjs'),
);
const { PhysioLatency } = require(
  path.join(ROOT, 'src/signal/physio_latency.mjs'),
);

const CACHE_DIR = path.join(__dirname, '.cache');
const INPUTS = (
  process.argv.length > 2
    ? process.argv.slice(2)
    : [path.join(ROOT, '..', 'tracks', 'Stokey.zip')]
).map((p) => path.resolve(p));
const LATENCIES = [0, 2];
const OFFSETS = Array.from({ length: 30 }, (_, i) => -30 + i * 2);
const NULL_PER_TRACK = 150;
const DECISIONS = ['turn', 'straight', 'control'];

// Overpass throttles clients without a User-Agent.
const nativeFetch = global.fetch;
global.fetch = (url, opts = {}) =>
  nativeFetch(url, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      'User-Agent': 'BioMapping-analysis/1.0 (research)',
    },
  });

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);
const se = (a) => {
  const m = mean(a);
  return Math.sqrt(mean(a.map((x) => (x - m) ** 2)) / a.length);
};
const fmt = (v, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '  -  ');

async function loadOsm(bbox) {
  const key = [bbox.minLat, bbox.minLon, bbox.maxLat, bbox.maxLon]
    .map((v) => v.toFixed(4))
    .join('_');
  const file = path.join(CACHE_DIR, `osm_${key}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  let json = null;
  for (let i = 0; i < 8 && !json; i++) {
    try {
      json = await OSMEnricher.fetchOSMData(bbox, () => {});
    } catch (e) {
      console.log(`overpass retry ${i}: ${String(e.message).slice(0, 60)}`);
      await new Promise((r) => setTimeout(r, 45000));
    }
  }
  if (!json) throw new Error('Overpass unavailable');
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json));
  return json;
}

/** Deterministic PRNG so the null is reproducible run to run. */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** [{ id, csv }] from zips (via their manifest) and plain CSV files. */
async function readInputs() {
  const out = [];
  for (const file of INPUTS) {
    if (!fs.existsSync(file)) {
      console.error(`Not found: ${file}`);
      process.exit(1);
    }
    if (file.endsWith('.zip')) {
      const zip = await JSZip.loadAsync(fs.readFileSync(file));
      const manifest = JSON.parse(
        await zip.file('manifest.json').async('string'),
      );
      for (const entry of manifest.tracks) {
        out.push({
          id: entry.file,
          csv: await zip.file(entry.file).async('string'),
        });
      }
    } else {
      out.push({ id: path.basename(file), csv: fs.readFileSync(file, 'utf8') });
    }
  }
  const seen = new Set();
  return out.filter(({ csv }) => {
    const key = crypto.createHash('sha1').update(csv).digest('hex');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

async function loadTracks(window) {
  const tracks = [];
  for (const { id, csv } of await readInputs()) {
    const analyzer = new window.GSRAnalyzer();
    analyzer.parseCSV(csv);
    const params =
      analyzer.importedFilterParams ||
      JSON.parse(JSON.stringify(window.GSR_CONST.GSR_DEFAULT));
    analyzer.analyze(params, 2);
    if (analyzer.raw.length && analyzer.phasic?.length) {
      tracks.push({ id, a: analyzer });
    }
  }
  return tracks;
}

/** Aligned series in the shape JunctionResponse.responses expects. */
function buildSeries(a) {
  const n = a.phasic.length;
  const series = {
    time: new Array(n),
    phasic: new Array(n),
    tonic: new Array(n),
    isPeak: new Array(n).fill(0),
  };
  for (let i = 0; i < n; i++) {
    series.time[i] = a.phasic[i].time;
    series.phasic[i] = a.phasic[i].val;
    series.tonic[i] = a.tonic?.[i]?.val ?? 0;
  }
  for (const pk of a.peaks) {
    if (!pk.excluded && pk.index != null && pk.index < n) {
      series.isPeak[pk.index] = 1;
    }
  }
  return series;
}

function snappedPoints(a, geoms) {
  a.osmGeoms = geoms;
  const snapped = OSMEnricher.analysisSnap(a, 25);
  if (!snapped) return [];
  const pts = [];
  for (let i = 0; i < a.raw.length; i++) {
    const sg = snapped[i];
    const r = a.raw[i];
    if (
      sg &&
      !Number.isNaN(sg.lat) &&
      !Number.isNaN(sg.lon) &&
      sg.wayId != null
    ) {
      pts.push({
        idx: i,
        time: r.time,
        lat: sg.lat,
        lon: sg.lon,
        wayId: sg.wayId,
        dist: sg.dist ?? 0,
        rawLat: r.lat,
        rawLon: r.lon,
      });
    }
  }
  return pts;
}

function report(title, rows, nullRows) {
  console.log(`\n=== ${title} ===`);
  console.log(
    'group       n   before   after   change  ±SE    dPeak/min  dTonic',
  );
  const line = (name, r) =>
    console.log(
      name.padEnd(10),
      String(r.length).padStart(4),
      fmt(mean(r.map((x) => x.before.meanPhasic))).padStart(7),
      fmt(mean(r.map((x) => x.after.meanPhasic))).padStart(7),
      fmt(mean(r.map((x) => x.delta.meanPhasic))).padStart(8),
      `±${fmt(se(r.map((x) => x.delta.meanPhasic)))}`,
      fmt(mean(r.map((x) => x.delta.peakRate)), 2).padStart(8),
      fmt(mean(r.map((x) => x.delta.meanTonic))).padStart(8),
    );
  for (const d of DECISIONS)
    line(
      d,
      rows.filter((x) => x.decision === d),
    );
  line('random-t', nullRows);
}

(async () => {
  const { window } = await boot();
  const tracks = await loadTracks(window);
  console.log(`${tracks.length} tracks from ${INPUTS.length} input(s)`);

  const all = tracks.flatMap((t) =>
    t.a.raw.filter((p) => p.lat && p.lon && Number.isFinite(p.lat + p.lon)),
  );
  const bbox = OSMEnricher.calculateBBox(all, 150);
  const geoms = OSMEnricher.reconstructGeometries(await loadOsm(bbox));

  const rows = Object.fromEntries(LATENCIES.map((L) => [L, []]));
  const nullRows = Object.fromEntries(LATENCIES.map((L) => [L, []]));
  const spans = [];
  const events = {}; // group → { ph/pk/sp: per-offset arrays, n }
  const rand = makeRng(12345);

  const addEvent = (group, prof) => {
    if (!events[group]) {
      events[group] = {
        n: 0,
        ph: OFFSETS.map(() => []),
        pk: OFFSETS.map(() => []),
        sp: OFFSETS.map(() => []),
      };
    }
    const e = events[group];
    e.n++;
    OFFSETS.forEach((_, i) => {
      e.ph[i].push(prof.ph[i]);
      e.pk[i].push(prof.pk[i]);
      e.sp[i].push(prof.sp[i]);
    });
  };

  for (const t of tracks) {
    const a = t.a;
    const pts = snappedPoints(a, geoms);
    if (pts.length < 2) continue;
    const passages =
      Junctions.classifyPassages(pts, geoms.ways, { includeControl: true }) ||
      [];
    passages.forEach((p) => {
      p.trackId = t.id;
    });

    const series = buildSeries(a);
    const { time, phasic, isPeak } = series;
    const dt = JunctionResponse._sampleInterval(time);
    const hz = dt > 0 ? 1 / dt : 10;
    const trackMean = mean(phasic);
    const t0 = time[0];
    const t1 = time[time.length - 1];

    for (const p of passages) {
      if (p.decision === 'turn' || p.decision === 'straight') {
        spans.push(p.timeExit - p.timeEnter);
      }
    }
    for (const L of LATENCIES) {
      rows[L].push(
        ...JunctionResponse.responses(passages, series, {
          trackId: t.id,
          lag: PhysioLatency.lags(L),
        }),
      );
    }

    const binMean = (arr, from) => {
      const lo = JunctionResponse._lowerBound(time, from);
      const hi = JunctionResponse._lowerBound(time, from + 2);
      return hi - lo < 10 ? NaN : mean(arr.slice(lo, hi));
    };
    const profile = (tc) => {
      const out = { ph: [], pk: [], sp: [] };
      for (const k of OFFSETS) {
        out.ph.push(binMean(phasic, tc + k) - trackMean);
        out.pk.push(binMean(isPeak, tc + k) * hz * 60);
        const lo = a.findClosestIndex(tc + k);
        const hi = a.findClosestIndex(tc + k + 2);
        const sp = [];
        for (let i = lo; i <= hi; i++)
          sp.push((a.raw[i].speedKts || 0) * 0.514444);
        out.sp.push(mean(sp));
      }
      return out;
    };

    const times = passages.map((p) => p.time);
    for (const p of passages) {
      if (!DECISIONS.includes(p.decision)) continue;
      if (p.time - 30 < t0 || p.time + 32 > t1) continue;
      const prof = profile(p.time);
      addEvent(p.decision, prof);
      if (times.every((x) => x === p.time || Math.abs(x - p.time) > 30)) {
        addEvent(`${p.decision}/iso`, prof);
      }
    }

    // Random-time null, ≥30 s from any passage and ≥20 s apart.
    const fake = [];
    for (let tries = 0; fake.length < NULL_PER_TRACK && tries < 5000; tries++) {
      const tt = t0 + 30 + rand() * (t1 - t0 - 62);
      if (times.some((x) => Math.abs(x - tt) < 30)) continue;
      if (fake.some((x) => Math.abs(x.time - tt) < 20)) continue;
      fake.push({
        key: `n${fake.length}`,
        decision: 'control',
        kind: 'control',
        time: tt,
        trackId: t.id,
      });
    }
    fake.sort((x, y) => x.time - y.time);
    for (const L of LATENCIES) {
      nullRows[L].push(
        ...JunctionResponse.responses(fake, series, {
          trackId: t.id,
          lag: PhysioLatency.lags(L),
        }),
      );
    }
    fake.forEach((p) => {
      addEvent('random-t', profile(p.time));
    });
  }

  for (const L of LATENCIES) {
    report(`window deltas, latency ${L} s (µS phasic)`, rows[L], nullRows[L]);
  }

  const lvl = (rs) => mean(rs.map((x) => x.before.meanPhasic));
  const chg = (rs) => mean(rs.map((x) => x.delta.meanPhasic));
  console.log('\n=== per track, latency 2 s: n / before-level / change ===');
  console.log(
    'track'.padEnd(34),
    'turn'.padEnd(20),
    'straight'.padEnd(20),
    'control',
  );
  const cell = (rs) =>
    rs.length
      ? `${String(rs.length).padStart(3)} ${fmt(lvl(rs), 2)} ${fmt(chg(rs), 2).padStart(5)}`
      : '  -';
  for (const t of tracks) {
    const r = rows[2].filter((x) => x.trackId === t.id);
    if (!r.length) continue;
    const by = (d) => r.filter((x) => x.decision === d);
    console.log(
      t.id.slice(0, 33).padEnd(34),
      cell(by('turn')).padEnd(20),
      cell(by('straight')).padEnd(20),
      cell(by('control')),
    );
  }

  const sorted = spans.sort((x, y) => x - y);
  const q = (f) =>
    sorted[Math.min(sorted.length - 1, Math.floor(f * sorted.length))];
  console.log(
    `\ntraversal (exit − enter), turn+straight passages: median ${fmt(q(0.5), 1)} s, p75 ${fmt(q(0.75), 1)} s, p95 ${fmt(q(0.95), 1)} s, max ${fmt(q(1), 1)} s ` +
      `(dropped above ${JunctionResponse.MAX_TRAVERSAL_S} s)`,
  );

  const groups = Object.keys(events);
  const table = (title, key, digits) => {
    console.log(
      `\n=== event-locked ${title}, place time 0 = junction entry ===`,
    );
    console.log(
      'offset'.padEnd(7) +
        groups.map((g) => `${g}(n=${events[g].n})`.padStart(18)).join(''),
    );
    for (const [i, k] of OFFSETS.entries()) {
      console.log(
        String(k).padStart(5) +
          '  ' +
          groups
            .map((g) =>
              fmt(
                mean(events[g][key][i].filter(Number.isFinite)),
                digits,
              ).padStart(18),
            )
            .join(''),
      );
    }
  };
  table('mean phasic (µS, track-mean-centred)', 'ph', 3);
  table('peak rate (/min)', 'pk', 1);
  table('speed (m/s)', 'sp', 2);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
