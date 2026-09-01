/**
 * Unit tests for the extracted 3D-globe helper modules under src/map/globe3d/:
 *   - exporters.js   (CZML / KML builders, pure — no viewer)
 *   - rf_expanse.js  (volumetric RF slug primitive)
 *   - buildings.js   (OSM footprint extrusion primitive)
 *
 * exporters run with no Cesium; rf/buildings use a tiny geometry-counting stub.
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const G3D = (f) => require(path.join(__dirname, '..', 'src', 'map', 'globe3d', f));
const { GSRGlobe3DExport } = G3D('exporters.js');

// ── tiny Cesium stub for the geometry modules ─────────────────────────────
function stubCesium() {
  const counts = { GeometryInstance: 0, EllipsoidGeometry: 0, PolygonGeometry: 0, WallGeometry: 0, PolygonOutlineGeometry: 0, Primitive: 0, PrimitiveCollection: 0 };
  global.Cesium = {
    Cartesian3: Object.assign(function (x, y, z) { return { x, y, z }; }, {
      fromDegrees: (lon, lat, h) => ({ lon, lat, h: h || 0 }),
      fromDegreesArray: (a) => a.slice(),
    }),
    Color: Object.assign(function (r, g, b, a) { return { r, g, b, a }; }, {
      fromCssColorString: (s) => ({ _css: s, withAlpha(a) { return { _css: s, a }; } }),
    }),
    ColorGeometryInstanceAttribute: { fromColor: (c) => c },
    EllipsoidGeometry: function (o) { counts.EllipsoidGeometry++; this._o = o; },
    PolygonGeometry: function (o) { counts.PolygonGeometry++; this._o = o; },
    WallGeometry: function (o) { counts.WallGeometry++; this._o = o; },
    PolygonOutlineGeometry: function (o) { counts.PolygonOutlineGeometry++; this._o = o; },
    PolygonHierarchy: function (p) { this.positions = p; },
    GeometryInstance: function (o) { counts.GeometryInstance++; Object.assign(this, o); },
    Primitive: function (o) { counts.Primitive++; this._o = o; this.geometryInstances = o.geometryInstances; },
    PrimitiveCollection: function () {
      counts.PrimitiveCollection++;
      this._prims = [];
      this.add = (p) => { this._prims.push(p); return p; };
      this.destroy = () => {};
      this.isDestroyed = () => false;
    },
    PerInstanceColorAppearance: function (o) { this._o = o; },
    Transforms: { eastNorthUpToFixedFrame: () => ({}) },
  };
  global.Cesium.PerInstanceColorAppearance.VERTEX_FORMAT = {};
  return counts;
}
function clearCesium() { delete global.Cesium; }

// A 4-point track; phasic drives the extruded height.
const analyzer = {
  raw: [{ gsr: 1 }, { gsr: 2 }, { gsr: 3 }, { gsr: 4 }],
  phasic: [{ val: 0 }, { val: 1 }, { val: 2 }, { val: 3 }],
  em_fog: [{ val: 10 }, { val: 20 }, { val: 30 }, { val: 40 }],
};
const drawPoints = [
  { lat: 51.500, lon: -0.100, origIdx: 0 },
  { lat: 51.501, lon: -0.101, origIdx: 1 },
  { lat: 51.502, lon: -0.102, origIdx: 2 },
  { lat: 51.503, lon: -0.103, origIdx: 3 },
];

test('buildCzml: one extruded wall entity, heights = base + max(0,val)*scale', () => {
  const czml = GSRGlobe3DExport.buildCzml(analyzer, drawPoints, {
    metric: 'phasic', baseHeight: 2, extrusionScale: 10,
  });
  const doc = JSON.parse(czml);
  assert.strictEqual(doc[0].id, 'document');
  const wall = doc[1].wall;
  // 4 points × [lon,lat,0]
  assert.deepStrictEqual(wall.positions.cartographicDegrees, [
    -0.100, 51.500, 0, -0.101, 51.501, 0, -0.102, 51.502, 0, -0.103, 51.503, 0,
  ]);
  assert.deepStrictEqual(wall.minimumHeights, [0, 0, 0, 0]);
  // phasic 0,1,2,3 -> 2 + val*10
  assert.deepStrictEqual(wall.maximumHeights, [2, 12, 22, 32]);
});

test('buildKml: extruded LineString, "lon,lat,height" lines, Google-Earth flags', () => {
  const kml = GSRGlobe3DExport.buildKml(analyzer, drawPoints, {
    metric: 'phasic', baseHeight: 0, extrusionScale: 5,
  });
  assert.match(kml, /<extrude>1<\/extrude>/);
  assert.match(kml, /<altitudeMode>relativeToGround<\/altitudeMode>/);
  // phasic 2 -> height 10.0
  assert.match(kml, /-0\.102,51\.502,10\.0/);
  assert.ok(kml.trim().endsWith('</kml>'));
});

test('resolveSeries: derived field, then raw-GSR fallback for an unknown metric', () => {
  assert.deepStrictEqual(GSRGlobe3DExport.resolveSeries(analyzer, 'em_fog'), [10, 20, 30, 40]);
  assert.deepStrictEqual(GSRGlobe3DExport.resolveSeries(analyzer, 'roadClass'), [1, 2, 3, 4]);
});

test('defaults are applied when opts omit baseHeight / extrusionScale / metric', () => {
  const doc = JSON.parse(GSRGlobe3DExport.buildCzml(analyzer, drawPoints, {}));
  const h = doc[1].wall.maximumHeights;
  // default metric 'phasic' (0,1,2,3), base 2.0, scale 8.0
  assert.deepStrictEqual(h, [2, 10, 18, 26]);
});

test('download(): builds a Blob anchor and clicks it, then revokes the URL', () => {
  const calls = { created: 0, clicked: 0, revoked: 0, appended: 0, removed: 0 };
  const anchor = { click() { calls.clicked++; }, set href(v) { this._href = v; }, get href() { return this._href; } };
  global.Blob = function (parts, opts) { this.parts = parts; this.type = opts && opts.type; };
  global.URL = { createObjectURL: () => { calls.created++; return 'blob:x'; }, revokeObjectURL: () => { calls.revoked++; } };
  global.document = {
    createElement: () => anchor,
    body: { appendChild: () => { calls.appended++; }, removeChild: () => { calls.removed++; } },
  };

  GSRGlobe3DExport.download('hello', 'a.czml', 'application/json');
  assert.deepStrictEqual(calls, { created: 1, clicked: 1, revoked: 1, appended: 1, removed: 1 });
  assert.strictEqual(anchor.download, 'a.czml');

  delete global.Blob; delete global.URL; delete global.document;
});

// ── rf_expanse.js ─────────────────────────────────────────────────────────

test('GSRGlobe3DRf.buildPrimitive: one Primitive of ≤SLUG_COUNT dome instances', () => {
  const counts = stubCesium();
  const { GSRGlobe3DRf } = G3D('rf_expanse.js');

  const n = 600;
  const raw = [];
  const drawPoints = [];
  for (let i = 0; i < n; i++) {
    raw.push({ rssi_815: -70 - (i % 20), rssi_868: -75, rssi_915: -60 });
    drawPoints.push({ lat: 51.5 + i * 1e-4, lon: -0.1, origIdx: i });
  }
  const prim = GSRGlobe3DRf.buildPrimitive({ raw }, drawPoints, { mode: 'triband', height: 25, opacity: 0.4 });
  assert.ok(prim, 'a primitive was built');
  assert.strictEqual(counts.Primitive, 1);
  assert.ok(counts.EllipsoidGeometry <= GSRGlobe3DRf.SLUG_COUNT && counts.EllipsoidGeometry > 0,
    `${counts.EllipsoidGeometry} slugs (cap ${GSRGlobe3DRf.SLUG_COUNT})`);
  assert.strictEqual(counts.GeometryInstance, counts.EllipsoidGeometry);
  clearCesium();
});

test('GSRGlobe3DRf.buildPrimitive: null when there is nothing to draw', () => {
  stubCesium();
  const { GSRGlobe3DRf } = G3D('rf_expanse.js');
  assert.strictEqual(GSRGlobe3DRf.buildPrimitive(null, [], {}), null);
  assert.strictEqual(GSRGlobe3DRf.buildPrimitive({ raw: [] }, [{ lat: 1, lon: 2, origIdx: 0 }], {}), null);
  assert.strictEqual(GSRGlobe3DRf.buildPrimitive({ raw: [{}] }, [], {}), null);
  clearCesium();
});

test('GSRGlobe3DRf.buildPrimitive: no hardware RF -> synthesises an ambient field', () => {
  const counts = stubCesium();
  const { GSRGlobe3DRf } = G3D('rf_expanse.js');
  const raw = Array.from({ length: 200 }, () => ({}));            // no rssi_* fields
  const drawPoints = raw.map((_, i) => ({ lat: 51 + i * 1e-4, lon: -0.1, origIdx: i }));
  const prim = GSRGlobe3DRf.buildPrimitive({ raw }, drawPoints, { mode: 'fog' });
  assert.ok(prim && counts.EllipsoidGeometry > 0, 'ambient slugs drawn even with no measured RF');
  clearCesium();
});

// ── buildings.js ──────────────────────────────────────────────────────────

const OSM_FIXTURE = {
  elements: [
    { type: 'node', id: 1, lat: 51.5000, lon: -0.1000 },
    { type: 'node', id: 2, lat: 51.5000, lon: -0.0990 },
    { type: 'node', id: 3, lat: 51.5010, lon: -0.0990 },
    { type: 'node', id: 4, lat: 51.5010, lon: -0.1000 },
    { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { building: 'yes', 'building:levels': '4' } },
    { type: 'way', id: 11, nodes: [1, 2, 3], tags: { building: 'office' } },
    { type: 'way', id: 12, nodes: [1, 2], tags: { building: 'yes' } },        // < 3 pts -> skipped
    { type: 'way', id: 13, nodes: [1, 2, 3, 4], tags: { highway: 'primary' } }, // not a building
  ],
};

test('GSRGlobe3DBuildings.buildPrimitive: one batched Primitive of the valid footprints only', () => {
  const counts = stubCesium();
  const { GSRGlobe3DBuildings } = G3D('buildings.js');
  const prim = GSRGlobe3DBuildings.buildPrimitive(OSM_FIXTURE, 'glass');
  assert.ok(prim);
  assert.strictEqual(counts.Primitive, 1);
  assert.strictEqual(counts.GeometryInstance, 2, 'only the two ≥3-node building ways');
  assert.strictEqual(prim._o.appearance._o.translucent, true, 'glass is translucent');
  clearCesium();
});

test('GSRGlobe3DBuildings.heightFor: explicit height > levels*3.5 > per-type > default', () => {
  stubCesium();
  const { GSRGlobe3DBuildings } = G3D('buildings.js');
  assert.strictEqual(GSRGlobe3DBuildings.heightFor({ height: '25' }), 25);
  assert.strictEqual(GSRGlobe3DBuildings.heightFor({ 'building:levels': '4' }), 14);
  assert.strictEqual(GSRGlobe3DBuildings.heightFor({ building: 'office' }), 16);
  assert.strictEqual(GSRGlobe3DBuildings.heightFor({ building: 'shed' }), 4);
  assert.strictEqual(GSRGlobe3DBuildings.heightFor({ building: 'yes' }), 9);
  clearCesium();
});

test('GSRGlobe3DBuildings.buildPrimitive: null for empty / non-building input', () => {
  stubCesium();
  const { GSRGlobe3DBuildings } = G3D('buildings.js');
  assert.strictEqual(GSRGlobe3DBuildings.buildPrimitive(null, 'glass'), null);
  assert.strictEqual(GSRGlobe3DBuildings.buildPrimitive({ elements: [] }, 'glass'), null);
  clearCesium();
});

test('GSRGlobe3DBuildings.buildPrimitive: realistic style creates solid extruded facade body, roof caps, and outlines in a PrimitiveCollection', () => {
  const counts = stubCesium();
  const { GSRGlobe3DBuildings } = G3D('buildings.js');
  const primColl = GSRGlobe3DBuildings.buildPrimitive(OSM_FIXTURE, 'realistic');
  assert.ok(primColl);
  assert.strictEqual(counts.PrimitiveCollection, 1, 'surface + outline primitives grouped in PrimitiveCollection');
  assert.strictEqual(counts.Primitive, 2, 'one surface primitive and one outline primitive');
  assert.strictEqual(counts.PolygonGeometry, 4, 'solid extruded bodies + roof caps for both buildings');
  assert.strictEqual(counts.PolygonOutlineGeometry, 2, 'roof outlines created for both buildings');
  clearCesium();
});

test('GSRGlobe3DBuildings.wallColorFor and roofColorFor assign distinct architectural palettes by tag', () => {
  stubCesium();
  const { GSRGlobe3DBuildings } = G3D('buildings.js');
  const resRoof = GSRGlobe3DBuildings.roofColorFor({ building: 'residential' });
  const offRoof = GSRGlobe3DBuildings.roofColorFor({ building: 'office' });
  const customRoof = GSRGlobe3DBuildings.roofColorFor({ 'roof:colour': '#ff0000' });
  assert.strictEqual(resRoof._css, '#a35242', 'residential terracotta cap');
  assert.strictEqual(offRoof._css, '#373d47', 'commercial/office slate charcoal cap');
  assert.strictEqual(customRoof._css, '#ff0000', 'explicit roof:colour tag respected');

  const resWall = GSRGlobe3DBuildings.wallColorFor({ building: 'house' });
  const offWall = GSRGlobe3DBuildings.wallColorFor({ building: 'commercial' });
  const customWall = GSRGlobe3DBuildings.wallColorFor({ 'building:colour': '#00ff00' });
  assert.strictEqual(resWall._css, '#dfd6c8', 'residential warm wall');
  assert.strictEqual(offWall._css, '#d6dbe0', 'commercial limestone wall');
  assert.strictEqual(customWall._css, '#00ff00', 'explicit building:colour tag respected');
  clearCesium();
});

test('GSRGlobe3DBuildings.tileStyleExpression covers every style', () => {
  stubCesium();
  const { GSRGlobe3DBuildings } = G3D('buildings.js');
  for (const s of ['glass', 'dark', 'monochrome', 'realistic']) {
    const expr = GSRGlobe3DBuildings.tileStyleExpression(s);
    assert.ok(expr.includes('color('), `style ${s} should produce a valid Cesium color expression`);
  }
  clearCesium();
});
