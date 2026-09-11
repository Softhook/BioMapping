'use strict';

const assert = require('assert');
const test   = require('node:test');

global.GSR_CONST = require('./mock_constants.js');
global.width = 1000;
global.height = 500;

// Mock p5.js drawing functions
const rectCalls = [];
const lineCalls = [];
const textCalls = [];
global.rect = (x, y, w, h) => rectCalls.push({ x, y, w, h });
global.line = (x1, y1, x2, y2) => lineCalls.push({ x1, y1, x2, y2 });
global.text = (txt, x, y) => textCalls.push({ txt, x, y });
global.noStroke = () => {};
global.stroke = () => {};
global.strokeWeight = () => {};
global.fill = () => {};
global.textAlign = () => {};
global.textSize = () => {};
global.textStyle = () => {};
global.BOLD = 'bold';
global.NORMAL = 'normal';
global.LEFT = 'left';
global.TOP = 'top';

// Real MapColors — the graph bands must reuse the exact colours the map's
// "Road Class" layer/legend already use, not a second palette.
const { MapColors } = require('../src/map/map_colors.js');
global.MapColors = MapColors;

// Real OSMEnricher (osm_enrichment.js needs GeoUtils as a global at require
// time — it reads GeoUtils.METERS_PER_DEG_LAT at module scope) so
// isVehicularRoad() is the exact same predicate osm_enrichment.js itself
// uses to pick a road over a footway, not a second copy of that class list.
global.GeoUtils = require('../src/gps/geo_utils.js').GeoUtils;
const { OSMEnricher } = require('../src/osm/osm_enrichment.js');
global.OSMEnricher = OSMEnricher;

const { GSRRenderer } = require('../src/render/renderer.js');

test('OSM classification reuses MapColors road/park colours (no separate palette)', () => {
  const primary = GSRRenderer._classifyOsmContext({ osm_road_class: 'primary', osm_in_park: 0 });
  assert.ok(primary);
  assert.strictEqual(primary.key, 'primary');
  assert.strictEqual(primary.label, 'PRIMARY');
  assert.strictEqual(primary.color, MapColors.ROAD_COLORS.primary);

  const secondary = GSRRenderer._classifyOsmContext({ osm_road_class: 'secondary' });
  assert.ok(secondary);
  assert.strictEqual(secondary.color, MapColors.ROAD_COLORS.secondary);

  const park = GSRRenderer._classifyOsmContext({ osm_road_class: null, osm_in_park: 1 });
  assert.ok(park);
  assert.strictEqual(park.key, 'park');
  assert.strictEqual(park.label, 'PARK');
  assert.strictEqual(park.color, MapColors.getColorForMetric('inPark', 1, 0, 1));

  const residential = GSRRenderer._classifyOsmContext({ osm_road_class: 'residential' });
  assert.ok(residential);
  assert.strictEqual(residential.label, 'RESIDENTIAL');
  assert.strictEqual(residential.color, MapColors.ROAD_COLORS.residential);

  const footway = GSRRenderer._classifyOsmContext({ osm_road_class: 'footway', osm_in_park: 0 });
  assert.ok(footway);
  assert.strictEqual(footway.color, MapColors.ROAD_COLORS.footway);

  // Unmapped/link tags fall back to the same grey the map uses, not a crash.
  const link = GSRRenderer._classifyOsmContext({ osm_road_class: 'motorway_link' });
  assert.ok(link);
  assert.strictEqual(link.label, 'MOTORWAY LINK');
  assert.strictEqual(link.color, '#666666');

  assert.strictEqual(GSRRenderer._classifyOsmContext({}), null);
});

test('Precedence: vehicular road beats park, but park beats a bare pedestrian path', () => {
  // A primary road running through a park is still traffic exposure — it
  // must read as the road, not get hidden behind "park".
  const crossedRoad = GSRRenderer._classifyOsmContext({ osm_road_class: 'primary', osm_in_park: 1 });
  assert.ok(crossedRoad);
  assert.strictEqual(crossedRoad.key, 'primary');

  // A residential street through a park is still vehicular — same precedence.
  const residentialInPark = GSRRenderer._classifyOsmContext({ osm_road_class: 'residential', osm_in_park: 1 });
  assert.strictEqual(residentialInPark.key, 'residential');

  // The case this whole precedence exists for: a footpath *inside* a park
  // (extremely common — paths crisscross every park) must read as park, not
  // collapse into the same generic "footway" colour a path on a grey urban
  // plaza would get. Losing the park signal here would make it nearly
  // invisible, since a walk through a park is rarely on grass the whole way.
  const footwayInPark = GSRRenderer._classifyOsmContext({ osm_road_class: 'footway', osm_in_park: 1 });
  assert.ok(footwayInPark);
  assert.strictEqual(footwayInPark.key, 'park');
  assert.strictEqual(footwayInPark.color, MapColors.getColorForMetric('inPark', 1, 0, 1));

  // Same for a cycleway or path inside a park.
  assert.strictEqual(GSRRenderer._classifyOsmContext({ osm_road_class: 'cycleway', osm_in_park: 1 }).key, 'park');
  assert.strictEqual(GSRRenderer._classifyOsmContext({ osm_road_class: 'path', osm_in_park: 1 }).key, 'park');

  // The same footway tag *outside* a park still reads as footway.
  const footwayOutsidePark = GSRRenderer._classifyOsmContext({ osm_road_class: 'footway', osm_in_park: 0 });
  assert.strictEqual(footwayOutsidePark.key, 'footway');

  // No road_class at all, but in a park -> park.
  const parkOnly = GSRRenderer._classifyOsmContext({ osm_road_class: null, osm_in_park: 1 });
  assert.strictEqual(parkOnly.key, 'park');
});

test('Park edge tolerance: a footpath just outside the park polygon still reads as park', () => {
  // The very common real-world case: osm_in_park is the strict point-in-
  // polygon test, but the park boundary and the footpath through it are
  // separate OSM edits — the path is frequently traced a few metres outside
  // the polygon it visually runs through. osm_dist_green (distance to the
  // nearest green-space boundary) within PARK_EDGE_TOLERANCE_M should still
  // read as park, or a walk through a park would show as almost entirely
  // "footway" with barely any park at all.
  const T = GSRRenderer.PARK_EDGE_TOLERANCE_M;

  const justOutside = GSRRenderer._classifyOsmContext({
    osm_road_class: 'footway', osm_in_park: 0, osm_dist_green: T - 1
  });
  assert.strictEqual(justOutside.key, 'park');

  const atTolerance = GSRRenderer._classifyOsmContext({
    osm_road_class: 'footway', osm_in_park: 0, osm_dist_green: T
  });
  assert.strictEqual(atTolerance.key, 'park');

  // Beyond the tolerance, it's genuinely a different place — reads as footway.
  const wellOutside = GSRRenderer._classifyOsmContext({
    osm_road_class: 'footway', osm_in_park: 0, osm_dist_green: T + 20
  });
  assert.strictEqual(wellOutside.key, 'footway');

  // The 999 "no green space within search radius" sentinel must never be
  // mistaken for "999m away, still close enough" — it means none was found.
  const noGreenNearby = GSRRenderer._classifyOsmContext({
    osm_road_class: 'footway', osm_in_park: 0, osm_dist_green: 999
  });
  assert.strictEqual(noGreenNearby.key, 'footway');

  // A vehicular road still wins even at zero distance from green space.
  const roadAtParkEdge = GSRRenderer._classifyOsmContext({
    osm_road_class: 'primary', osm_in_park: 0, osm_dist_green: 0
  });
  assert.strictEqual(roadAtParkEdge.key, 'primary');
});

test('drawOsmContextBands generates run-length encoded segments and draws rects', () => {
  rectCalls.length = 0;
  lineCalls.length = 0;

  // Mock raw signal samples across 10 seconds:
  // 0s..3s: footway outside any park
  // 3s..5s: primary (major road crossing)
  // 5s..8s: footway INSIDE a park (classifies as 'park', not 'footway')
  // 8s..10s: residential (minor road)
  const raw = [];
  for (let i = 0; i <= 100; i++) {
    const t = i * 0.1;
    let rc = 'footway', inPark = 0;
    if (t >= 3.0 && t < 5.0) {
      rc = 'primary';
    } else if (t >= 5.0 && t < 8.0) {
      rc = 'footway';
      inPark = 1;
    } else if (t >= 8.0) {
      rc = 'residential';
    }
    raw.push({ time: t, val: 1.0, osm_road_class: rc, osm_in_park: inPark });
  }

  global.AppState = {
    analyzer: {
      raw,
      findClosestIndex(t) {
        return Math.max(0, Math.min(raw.length - 1, Math.round(t * 10)));
      }
    }
  };

  GSRRenderer.drawOsmContextBands(0, 10, 50, 400);

  // We expect 4 distinct segments (footway, primary, park, residential)
  assert.strictEqual(rectCalls.length, 4, 'Should draw 4 contiguous rectangles');

  // Verify Y dimensions are consistent
  rectCalls.forEach(r => {
    assert.strictEqual(r.y, 50);
    assert.strictEqual(r.h, 350);
    assert.ok(r.w > 0);
  });

  // Verify that major road crossing generated vertical boundary lines
  assert.ok(lineCalls.length > 0, 'Should have drawn boundary lines for road crossing / park edges');
});
