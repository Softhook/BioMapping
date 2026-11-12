/**
 * Builds demo/walk.json for the front-page demo (index.html at the repo root).
 *
 * Runs the visualiser's own analysis on the public demo walk
 * (visualiser/fixtures/default_processed.csv) with the default settings, and
 * keeps only what the demo draws: the route, the phasic (moment-to-moment)
 * skin response along it, the detected peaks, and nearby building footprints.
 *
 * The route is locked to the roads the same way the visualiser does it with
 * road snapping on: smooth the GPS, match it to OpenStreetMap roads
 * (OSMEnricher.snapTrackGps), then rebuild the smoothed path with the snap
 * pulled in (GpsPipeline.ensureFilteredGps).
 *
 * The OpenStreetMap download (roads + buildings, the visualiser's own query)
 * is kept in demo/.cache/osm.json, so re-runs work offline. Pass --refresh to
 * download it again.
 *
 * Run from the repo root:  node demo/bake_demo_data.cjs
 */

const fs = require('node:fs');
const path = require('node:path');

global.window = global;
const SRC = path.join(__dirname, '../visualiser/src/');
const { GSR_CONST } = require(`${SRC}core/constants.mjs`);
global.GSR_CONST = GSR_CONST;
const { GSRAnalyzer } = require(`${SRC}signal/analyzer.mjs`);
const { GpsPipeline } = require(`${SRC}gps/gps_pipeline.mjs`);
const { GeoUtils } = require(`${SRC}gps/geo_utils.mjs`);
const { OSMEnricher } = require(`${SRC}osm/osm_enrichment.mjs`);
const { OverpassClient } = require(`${SRC}osm/overpass_client.mjs`);

const CSV = path.join(__dirname, '../visualiser/fixtures/default_processed.csv');
const OUT = path.join(__dirname, 'walk.json');
const OSM_CACHE = path.join(__dirname, '.cache/osm.json');
const STEP_S = 0.5; // one demo sample per half second of walking
const AREA_PAD_M = 450; // map data around the route (the buildings in view)

// ── OpenStreetMap download ─────────────────────────────────────────────────
async function loadOsm(bbox) {
  if (fs.existsSync(OSM_CACHE) && !process.argv.includes('--refresh')) {
    return JSON.parse(fs.readFileSync(OSM_CACHE, 'utf8'));
  }
  // The visualiser's own query, sent with a client name: Overpass refuses
  // Node's bare default request.
  const body = `data=${encodeURIComponent(OverpassClient.buildQuery(bbox))}`;
  let lastErr = 'unreachable';
  for (const url of OverpassClient.ENDPOINTS) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
        'User-Agent': 'BioMapping-demo-bake/1.0',
      },
      body,
    }).catch((e) => ({ ok: false, status: e.message }));
    if (res.ok) {
      const json = await res.json();
      fs.mkdirSync(path.dirname(OSM_CACHE), { recursive: true });
      fs.writeFileSync(OSM_CACHE, JSON.stringify(json));
      return json;
    }
    lastErr = res.status;
  }
  throw new Error(`OpenStreetMap download failed (${lastErr})`);
}

// Building footprints for the demo: [height in metres, [lon, lat, …]]
function buildingsFrom(osm) {
  const nodes = new Map();
  for (const el of osm.elements) {
    if (el.type === 'node') nodes.set(el.id, el);
  }
  const out = [];
  for (const el of osm.elements) {
    if (el.type !== 'way' || !el.tags?.building || !el.nodes) continue;
    const ring = [];
    for (const id of el.nodes) {
      const n = nodes.get(id);
      if (n) ring.push(+n.lon.toFixed(6), +n.lat.toFixed(6));
    }
    if (ring.length < 8) continue; // under 3 corners + closing point
    let h = parseFloat(el.tags.height);
    if (!(h > 0)) {
      const lv = parseFloat(el.tags['building:levels']);
      h = lv > 0 ? lv * 3.2 + 1.5 : 10;
    }
    out.push([+h.toFixed(1), ring]);
  }
  return out;
}

(async () => {
  // ── Analyse ──────────────────────────────────────────────────────────────
  const a = new GSRAnalyzer();
  a.parseCSV(fs.readFileSync(CSV, 'utf8'));
  a.analyze({ ...GSR_CONST.GSR_DEFAULT });
  const raw = a.raw;

  // ── Route: smooth, snap to roads, rebuild ────────────────────────────────
  const gpsParams = {
    maxHdop: GSR_CONST.GPS_DEFAULT.maxHdop,
    maxSpeed: GSR_CONST.GPS_DEFAULT.maxSpeed,
  };
  GpsPipeline.ensureFilteredGps(a, gpsParams);
  const unsnapped = a.filteredGps.map((g) => ({ lat: g.lat, lon: g.lon }));

  const osm = await loadOsm(
    OSMEnricher.calculateBBox(
      unsnapped.filter((g) => Number.isFinite(g.lat)),
      AREA_PAD_M,
    ),
  );
  const geoms = OSMEnricher.reconstructGeometries(osm);
  const snapped = OSMEnricher.snapTrackGps(
    a,
    geoms,
    GSR_CONST.ENRICHMENT_DEFAULT.snapRadius,
  );
  if (!snapped) throw new Error('Road snapping found no roads near the route');
  GpsPipeline.ensureFilteredGps(a, gpsParams); // now with the snap pulled in

  let moved = 0;
  let movedMax = 0;
  let movedN = 0;
  for (let i = 0; i < raw.length; i++) {
    const u = unsnapped[i];
    const s = a.filteredGps[i];
    if (!Number.isFinite(u.lat) || !Number.isFinite(s?.lat)) continue;
    const d = GeoUtils.haversineMeters(u.lat, u.lon, s.lat, s.lon);
    moved += d;
    movedMax = Math.max(movedMax, d);
    movedN++;
  }

  // ── Resample to STEP_S buckets ───────────────────────────────────────────
  // Position is the bucket average; the skin response is the bucket maximum
  // so short peaks survive the thinning.
  const t0 = raw[0].time;
  const buckets = new Map();
  for (let i = 0; i < raw.length; i++) {
    const g = a.filteredGps[i];
    if (!g || Number.isNaN(g.lat) || Number.isNaN(g.lon)) continue;
    const k = Math.floor((raw[i].time - t0) / STEP_S);
    let b = buckets.get(k);
    if (!b) buckets.set(k, (b = { lat: 0, lon: 0, n: 0, v: -Infinity, i }));
    b.lat += g.lat;
    b.lon += g.lon;
    b.n++;
    b.v = Math.max(b.v, a.phasic[i].val);
  }
  const keys = [...buckets.keys()].sort((x, y) => x - y);
  const samples = keys.map((k) => {
    const b = buckets.get(k);
    return [
      +(b.lat / b.n).toFixed(6),
      +(b.lon / b.n).toFixed(6),
      +Math.max(0, b.v).toFixed(4),
    ];
  });
  // raw row index -> demo sample index
  const firstRow = keys.map((k) => buckets.get(k).i);
  const sampleOfRow = (row) => {
    let lo = 0;
    let hi = firstRow.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (firstRow[mid] <= row) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const peaks = a.peaks
    .filter((p) => !p.excluded)
    .map((p) => [sampleOfRow(p.index), +p.amplitude.toFixed(3)]);

  let distanceM = 0;
  for (let i = 1; i < samples.length; i++) {
    distanceM += GeoUtils.haversineMeters(
      samples[i - 1][0],
      samples[i - 1][1],
      samples[i][0],
      samples[i][1],
    );
  }

  const buildings = buildingsFrom(osm);
  fs.writeFileSync(
    OUT,
    JSON.stringify({
      source: 'visualiser/fixtures/default_processed.csv',
      place: 'Edinburgh',
      snappedToRoads: true,
      stepSeconds: STEP_S,
      durationSeconds: Math.round(raw.at(-1).time - t0),
      distanceMetres: Math.round(distanceM),
      samples,
      peaks,
      buildings,
    }),
  );
  console.log(
    `walk.json: ${samples.length} samples, ${peaks.length} peaks, ` +
      `${buildings.length} buildings, ${(distanceM / 1000).toFixed(2)} km, ` +
      `${(fs.statSync(OUT).size / 1024).toFixed(0)} KB\n` +
      `road snap moved the route ${(moved / movedN).toFixed(1)} m on average ` +
      `(at most ${movedMax.toFixed(1)} m)`,
  );
})().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
