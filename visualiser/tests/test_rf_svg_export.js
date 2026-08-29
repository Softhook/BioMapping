/**
 * Unit Test: Sub-GHz RF Data Vector SVG Export (Single Track & Collective View)
 * Verifies RFFluidRenderer.exportToSvgElements and GSRMapExporter RF layer generation.
 */
const assert = require('assert');
const fs     = require('fs');
const path   = require('path');
const vm     = require('vm');

global.window = global;

function loadModule(filePath, varName) {
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src.replace(
    new RegExp(`class ${varName}\\s*{`),
    `global.${varName} = class ${varName} {`
  ).replace(
    new RegExp(`const ${varName}\\s*=`),
    `global.${varName} =`
  );
  vm.runInThisContext(wrapped, { filename: filePath });
}

loadModule(path.join(__dirname, '../src/signal/stats_math.js'),        'StatsMath');
loadModule(path.join(__dirname, '../src/map/map_colors.js'),        'MapColors');
loadModule(path.join(__dirname, '../src/gps/geo_utils.js'),         'GeoUtils');
loadModule(path.join(__dirname, '../src/map/spatial_grid.js'),       'SpatialGrid');
loadModule(path.join(__dirname, '../src/render/rf_fluid_renderer.js'), 'RFFluidRenderer');
loadModule(path.join(__dirname, '../src/map/map_exporter.js'),     'GSRMapExporter');

const RFFluidRenderer = global.RFFluidRenderer;
const GSRMapExporter = global.GSRMapExporter;

console.log('── Running Sub-GHz RF Data Vector SVG Export Unit Test ──');

// Mock Leaflet Map interface
const mockMap = {
  createPane: () => ({ style: {} }),
  getPane: () => null,
  getSize: () => ({ x: 800, y: 600 }),
  getBounds: () => ({
    pad: () => ({
      contains: () => true,
      getNorthWest: () => ({ lat: 51.51, lng: -0.11 }),
      getSouthEast: () => ({ lat: 51.49, lng: -0.09 })
    })
  }),
  latLngToLayerPoint: (ll) => {
    const lat = Array.isArray(ll) ? ll[0] : ll.lat;
    const lon = Array.isArray(ll) ? ll[1] : (ll.lon || ll.lng);
    return { x: (lon - (-0.11)) * 10000, y: (51.51 - lat) * 10000 };
  },
  on: () => {}
};

// 1. Instantiate RFFluidRenderer
const renderer = new RFFluidRenderer(mockMap, { visible: true, mode: 'triband' });

// Mock synthetic draw points with RF RSSI readings
const drawPoints = [
  { lat: 51.501, lon: -0.101, rssi_815: -72.0, rssi_868: -80.0, rssi_915: -65.0 },
  { lat: 51.502, lon: -0.102, rssi_815: -68.0, rssi_868: -75.0, rssi_915: -60.0 },
  { lat: 51.503, lon: -0.103, rssi_815: -85.0, rssi_868: -88.0, rssi_915: -70.0 }
];

const mockOsmGeoms = {
  ways: [
    {
      type: 'way',
      tags: { building: 'yes' },
      coordinates: [
        { lat: 51.5015, lon: -0.1015 },
        { lat: 51.5018, lon: -0.1015 },
        { lat: 51.5018, lon: -0.1012 },
        { lat: 51.5015, lon: -0.1012 }
      ]
    }
  ]
};

renderer.setData(drawPoints, mockOsmGeoms);

assert(renderer.cachedNodes.length > 0, 'RFFluidRenderer should cache RF nodes');

// Mock Mercator projection for exporter
const project = (ll) => {
  const lat = ll.lat !== undefined ? ll.lat : ll[0];
  const lon = ll.lon !== undefined ? ll.lon : (ll.lng !== undefined ? ll.lng : ll[1]);
  return { x: (lon - (-0.11)) * 10000, y: (51.51 - lat) * 10000 };
};

// 2. Export SVG elements from RFFluidRenderer
const svgElements = renderer.exportToSvgElements(project, 2000, 2000);

assert(Array.isArray(svgElements.defs), 'exportToSvgElements should return defs array');
assert(Array.isArray(svgElements.polygons), 'exportToSvgElements should return polygons array');
assert(svgElements.polygons.length > 0, 'Should generate SVG polygon elements for RF ray fans');

const hasGradient = svgElements.defs.some(d => d.includes('<radialGradient'));
const hasBuildingMask = svgElements.defs.some(d => d.includes('id="rfBuildingMask"'));

assert(hasGradient, 'SVG defs must contain radialGradient definitions for RF nodes');
assert(hasBuildingMask, 'SVG defs must contain building clip mask for OSM shapes');

console.log(`✔ Generated ${svgElements.polygons.length} RF vector polygon elements`);
console.log(`✔ Generated ${svgElements.defs.length} SVG defs (radial gradients + building mask)`);

// 3. Verify GSRMapExporter full SVG assembly
const mockManager = {
  map: mockMap,
  rfFluidRenderer: renderer,
  pathSegments: [],
  collectivePathSegments: [],
  contourLayers: [],
  clusterLayers: [],
  peakMarkers: [],
  collectivePeakMarkers: [],
  osmLayers: []
};

const mockEl = { clientWidth: 800, clientHeight: 600, querySelectorAll: () => [], querySelector: () => null };
const ctx = {
  map: mockMap,
  el: mockEl,
  r: { left: 0, top: 0 },
  w: 2000,
  h: 2000,
  project,
  mgr: mockManager
};

const rfLayerData = GSRMapExporter._rfFluid(ctx);
assert(rfLayerData.polygons.length > 0, '_rfFluid must collect RF polygons from renderer');

const fullSvgMarkup = GSRMapExporter._render(ctx, {
  tiles: [],
  rfFluid: rfLayerData,
  surface: { mesh: [], isobands: [] },
  osm: [],
  tracks: [],
  contours: [],
  clusters: [],
  dotsAndLabels: { dots: [], labels: [] },
  hotspots: { dots: [] }
});

assert(fullSvgMarkup.includes('id="RF_Fluid_Field"'), 'SVG output must include RF_Fluid_Field group layer');
assert(fullSvgMarkup.includes('id="RF_815MHz_LTE"'), 'SVG output must include RF_815MHz_LTE sub-layer');
assert(fullSvgMarkup.includes('id="RF_868MHz_Grid"'), 'SVG output must include RF_868MHz_Grid sub-layer');
assert(fullSvgMarkup.includes('id="RF_915MHz_SubGHz"'), 'SVG output must include RF_915MHz_SubGHz sub-layer');
assert(fullSvgMarkup.includes('mask="url(#rfBuildingMask)"'), 'RF_Fluid_Field layer must apply building mask');
assert(!fullSvgMarkup.includes('NaN'), 'SVG output must contain zero NaN values');

console.log('✔ Generated separated Illustrator frequency sub-layers (815, 868, 915 MHz)');
console.log('✔ Full SVG rendering integration passed with zero NaN coordinates');

// 4. Regression: RF_Fluid_Field's OWN opening tag must isolate its children's
// screen blend from whatever's painted underneath (tiles), while still
// carrying the building mask when one exists.
//
// Reported bug: "in single track mode the RF fluid layer seems to SVG
// export as a white shape." First traced to `rfMasterAttr = hasMask ?
// maskAttr : screenBlendStyle` — whenever a track had OSM building
// enrichment, the mask attribute was substituted IN PLACE OF
// mix-blend-mode:screen on the wrapping group, so overlapping RF gradients
// normal-blended into an opaque mess. That was real and is still fixed
// (mask no longer displaces the isolation setup below) — but it wasn't the
// actual root cause: the user confirmed toggling the basemap tile layer OFF
// made the RF field render correctly, proving the RF geometry itself was
// always fine. `mix-blend-mode` on a descendant blends against EVERYTHING
// already painted behind it in the same stacking context — not just its
// own siblings — so even with the mask+blend fix, RF_Fluid_Field's screen
// blend was reaching through to Base_Map_Tiles (painted earlier in the
// SVG). CartoDB's "light_all" basemap is light-colored, and
// screen(anything, near-white) collapses to near-white, so wherever tiles
// were visible the whole RF field washed out to white regardless of its
// own content. `isolation: isolate` gives RF_Fluid_Field its own stacking
// context: the per-band sub-layers' own mix-blend-mode:screen (815/868/915/
// fog, asserted above) still combines THEM with each other correctly, but
// the group as a whole then composites normally on top of the tiles below.
const rfFieldTagMatch = fullSvgMarkup.match(/<g[^>]*id="RF_Fluid_Field"[^>]*>/);
assert(rfFieldTagMatch, 'RF_Fluid_Field opening tag must be present in the SVG output');
const rfFieldTag = rfFieldTagMatch[0];
assert(rfFieldTag.includes('mask="url(#rfBuildingMask)"'), 'RF_Fluid_Field must still carry the building mask when one exists');
assert(rfFieldTag.includes('isolation: isolate'), 'RF_Fluid_Field must isolate its blend context so its screen blend does not reach through to the tiles below it');
assert(!rfFieldTag.includes('mix-blend-mode'), 'RF_Fluid_Field itself must NOT carry mix-blend-mode — only its per-band sub-layers should (screening against the tiles is exactly the bug)');

console.log('✔ RF_Fluid_Field isolates its blend context from the tiles below it, and still keeps the building mask');
console.log('── All Sub-GHz RF Data SVG Export Tests Passed Successfully ──');
