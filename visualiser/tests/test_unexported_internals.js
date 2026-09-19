/**
 * Authoritative verification test that Category 1 internal helpers and constants
 * are truly private:
 * 1. Runtime export assertion: asserts each symbol is `undefined` on the module's export surface,
 *    while the module's public contract remains intact and functional.
 * 2. Static non-reference assertion: scans all source files in `src/` and test files in `tests/`
 *    to prove that no other module in the codebase imports or requires any of these symbols.
 *
 * Run: node --test tests/test_unexported_internals.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

const UNEXPORTED_TARGETS = {
  'src/map/globe3d/rf_expanse.mjs': {
    unexported: [
      'clamp01',
      'haversineM',
      'lerpRf',
      'bandHasActiveSignal',
      'normDbm',
    ],
    expectedExports: ['GSRGlobe3DRf'],
  },
  'src/osm/osm_enrichment.mjs': {
    unexported: [
      'METERS_PER_DEG_LAT',
      'CELL_SIZE_DEG',
      'SENTINEL_DIST',
      'DEFAULT_RADIUS_M',
      'DEFAULT_BBOX_BUFFER_M',
      '_geomsCache',
      '_spatialIndexCache',
      'SAMPLING_RINGS',
      'POINTS_PER_RING',
      'MAJOR_ROAD_CLASSES',
      'VEHICULAR_ROAD_CLASSES',
      'NON_ROAD_HIGHWAY',
      'AMENITY_TYPES',
      'GREEN_LEISURE',
      'GREEN_LANDUSE',
      'GREEN_NATURAL',
      'WATER_NATURAL',
      'WATER_WATERWAY',
      'WATER_LANDUSE',
      'CANOPY_NATURAL_AREA',
      'CANOPY_LANDUSE_AREA',
      'CANOPY_BUFFER_M',
      '_isGreenSpace',
      '_isCanopy',
      '_isWaterSpace',
      '_classifyRoad',
      '_centroidOf',
      '_isPointInGreenSpace',
    ],
    expectedExports: ['OSMEnricher'],
  },
  'src/render/label_placement.mjs': {
    unexported: ['YBandIndex'],
    expectedExports: ['GSRLabelManager'],
  },
  'src/map/globe3d.mjs': {
    unexported: ['rawMetricField', 'WALL_MAX_SEGMENTS'],
    expectedExports: [
      'GSRGlobeManager',
      'seriesValue',
      'SERIES_FIELD',
      'BASEMAP_PROVIDERS',
    ],
  },
  'src/map/globe3d/exporters.mjs': {
    unexported: ['G3DX_SERIES_FIELD', 'g3dxSeriesValue'],
    expectedExports: ['GSRGlobe3DExport'],
  },
  'src/map/map_exporter.mjs': {
    unexported: ['SVG_NS', 'XLINK_NS', 'AI_NS', 'BG', 'LABEL'],
    expectedExports: ['GSRMapExporter'],
  },
  'src/map/manager/path.mjs': {
    unexported: ['DERIVED_METRIC_SERIES', 'DISTANCE_METRICS', 'isNoDataValue'],
    expectedExports: ['GSRMapPath'],
  },
  'src/map/basemap.mjs': {
    unexported: ['CARTO_ATTRIBUTION'],
    expectedExports: ['GSRBasemap'],
  },
  'src/map/globe3d_view.mjs': {
    unexported: ['CESIUM_BASE'],
    expectedExports: ['GSRGlobe3DView'],
  },
  'src/render/rf_signal_utils.mjs': {
    unexported: ['HARD_NOISE_FLOOR_DBM', 'NORM_GAMMA', 'DEFAULT_GAIN'],
    expectedExports: ['bandHasActiveSignal', 'normDbm'],
  },
  'tests/support/boot_app.js': {
    unexported: ['superMock'],
    expectedExports: ['bootApp', 'SCRIPT_ORDER'],
  },
  'tests/support/gps_characterization.js': {
    unexported: ['collectGpsPoints', 'pathLengthMeters'],
    expectedExports: ['computeCharacterizationMetrics'],
  },
};

test('authoritative check: internal helpers/constants are not on module export surfaces', () => {
  for (const [relPath, { unexported, expectedExports }] of Object.entries(
    UNEXPORTED_TARGETS,
  )) {
    const fullPath = path.join(ROOT_DIR, relPath);
    assert(
      fs.existsSync(fullPath),
      `Target file ${relPath} must exist on disk`,
    );

    const mod = require(fullPath);

    // 1. Assert all expected public interfaces are present
    for (const exp of expectedExports) {
      assert(
        mod[exp] !== undefined,
        `Expected public export "${exp}" in ${relPath} must be defined`,
      );
    }

    // 2. Assert all internal helpers/constants are NOT exposed
    for (const sym of unexported) {
      assert.strictEqual(
        mod[sym],
        undefined,
        `Internal symbol "${sym}" should NOT be exported by ${relPath}`,
      );
    }
  }
});

function getAllFiles(dir, exts, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== '.git') {
        getAllFiles(p, exts, acc);
      }
    } else if (exts.includes(path.extname(entry.name))) {
      acc.push(p);
    }
  }
  return acc;
}

test('authoritative check: no external module imports or requires any unexported internal symbol', () => {
  const allFiles = [
    ...getAllFiles(path.join(ROOT_DIR, 'src'), ['.mjs', '.js']),
    ...getAllFiles(path.join(ROOT_DIR, 'tests'), ['.js', '.mjs']),
  ].filter((f) => f !== __filename);

  const violations = [];

  for (const [relPath, { unexported }] of Object.entries(UNEXPORTED_TARGETS)) {
    const fullDeclaringPath = path.resolve(ROOT_DIR, relPath);
    const baseName = path.basename(relPath).replace(/\.(?:mjs|js)$/, '');

    for (const filePath of allFiles) {
      if (path.resolve(filePath) === fullDeclaringPath) continue; // Declaring file can define/use it internally

      const content = fs.readFileSync(filePath, 'utf8');

      for (const sym of unexported) {
        // Pattern 1: Named ES import matching symbol from declaring file baseName
        // e.g. import { clamp01 } from './rf_expanse.mjs';
        const importPattern = new RegExp(
          `import\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}\\s*from\\s*['"][^'"]*${baseName}(?:\\.mjs)?['"]`,
        );
        if (importPattern.test(content)) {
          violations.push(
            `File ${path.relative(ROOT_DIR, filePath)} imports "${sym}" from ${relPath}`,
          );
        }

        // Pattern 2: CJS require destructuring or property access
        // e.g. require('./rf_expanse').clamp01 or const { clamp01 } = require('./rf_expanse')
        const cjsDestructPattern = new RegExp(
          `const\\s*\\{[^}]*\\b${sym}\\b[^}]*\\}\\s*=\\s*require\\([^)]*${baseName}[^)]*\\)`,
        );
        const cjsPropPattern = new RegExp(
          `require\\([^)]*${baseName}[^)]*\\)\\.${sym}\\b`,
        );
        if (cjsDestructPattern.test(content) || cjsPropPattern.test(content)) {
          violations.push(
            `File ${path.relative(ROOT_DIR, filePath)} requires "${sym}" from ${relPath}`,
          );
        }
      }
    }
  }

  assert.strictEqual(
    violations.length,
    0,
    `Found unexpected external references to internal symbols:\n${violations.join('\n')}`,
  );
});
