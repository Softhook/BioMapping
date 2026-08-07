'use strict';
/**
 * Unit tests for hillshade.js — the Horn's-method slope/aspect + Lambertian
 * relief shading used by map.js renderContours() to shade the collective
 * surface. Tests the algorithm against convention-independent physical
 * invariants (rather than asserting a specific compass direction reads
 * "bright") since the azimuth-to-math-angle calibration is easy to get
 * subtly backwards without changing whether the formula itself is correct —
 * see hillshade.js's own comment on why aspect is computed the way it is.
 *
 * Run: node tests/test_hillshade.js
 */
const assert = require('assert');
const { Hillshade } = require('../hillshade.js');

console.log('── Running Hillshade Algorithm Test ──');

// ── Test 1: a perfectly flat surface shades uniformly at cos(altitude),
// independent of azimuth (slope=0 means the azimuth/aspect term vanishes
// entirely — this isolates the altitude term from the slope/aspect math). ──
{
  const rows = 10, cols = 10;
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(5));
  for (const altitudeDeg of [10, 45, 80]) {
    for (const azimuthDeg of [0, 90, 180, 270]) {
      const shade = Hillshade.compute(grid, rows, cols, 1, 1, { azimuthDeg, altitudeDeg });
      const expected = Math.cos((altitudeDeg * Math.PI) / 180);
      for (let r = 1; r < rows - 1; r++) {
        for (let c = 1; c < cols - 1; c++) {
          assert(
            Math.abs(shade[r * cols + c] - expected) < 1e-5,
            `Flat grid (alt=${altitudeDeg}, az=${azimuthDeg}) cell (${r},${c}) shade=${shade[r * cols + c]} should equal cos(altitude)=${expected}`
          );
        }
      }
    }
  }
  console.log('✓ Flat surface shades uniformly at cos(altitude), independent of azimuth');
}

// ── Test 2: a tilted plane's illumination, scanned over every azimuth, has
// a maximum of cos(altitude - slope) and a minimum of max(0, cos(altitude + slope))
// — the closed-form bounds any Lambertian relief-shading formula must hit
// regardless of the azimuth/aspect compass calibration. ─────────────────────
{
  const rows = 12, cols = 12;
  // Simple ramp: value rises with column (no row variation), so the whole
  // grid is one uniform planar slope with a single well-defined aspect.
  const grid = Array.from({ length: rows }, () => Array.from({ length: cols }, (_, c) => c * 3));
  const altitudeDeg = 45;

  let maxShade = -Infinity, minShade = Infinity, argmaxAz = null, argminAz = null;
  for (let az = 0; az < 360; az += 5) {
    const shade = Hillshade.compute(grid, rows, cols, 1, 1, { azimuthDeg: az, altitudeDeg });
    const v = shade[Math.floor(rows / 2) * cols + Math.floor(cols / 2)]; // interior cell, away from edge fallback
    if (v > maxShade) { maxShade = v; argmaxAz = az; }
    if (v < minShade) { minShade = v; argminAz = az; }
  }

  // Recover the plane's actual slope analytically the same way the
  // interior cell would (dzdx=3, dzdy=0, zFactor=1 default) to compute the
  // expected bounds independently of Hillshade's internals.
  const slopeRad = Math.atan(Math.sqrt(3 * 3 + 0 * 0));
  const altitudeRad = (altitudeDeg * Math.PI) / 180;
  const expectedMax = Math.cos(altitudeRad - slopeRad);
  const expectedMin = Math.max(0, Math.cos(altitudeRad + slopeRad));

  assert(Math.abs(maxShade - expectedMax) < 0.02, `Max shade over all azimuths (${maxShade.toFixed(4)}) should match cos(altitude-slope)=${expectedMax.toFixed(4)}`);
  assert(Math.abs(minShade - expectedMin) < 0.02, `Min shade over all azimuths (${minShade.toFixed(4)}) should match max(0,cos(altitude+slope))=${expectedMin.toFixed(4)}`);

  // The point diametrically opposite the (unique) brightest azimuth must be
  // at the illumination minimum — i.e. sun-facing vs sun-away. Checked via
  // the exact opposite of the well-defined argmax, not a scanned "argmin":
  // the minimum is a wide CLAMPED PLATEAU (illumination goes negative across
  // the whole self-shadowed side and gets floored to 0 — see the profile
  // this exposed), so scanning for "first cell equal to the minimum" isn't
  // well-defined and shifts arbitrarily under a reflection of the sweep,
  // which is exactly what azimuth-to-compass calibration is (see Test 6).
  const oppositeAz = (argmaxAz + 180) % 360;
  const oppositeShade = Hillshade.compute(grid, rows, cols, 1, 1, { azimuthDeg: oppositeAz, altitudeDeg })[Math.floor(rows / 2) * cols + Math.floor(cols / 2)];
  assert(Math.abs(oppositeShade - minShade) < 0.02, `Shade directly opposite the brightest azimuth (${oppositeShade.toFixed(4)}) should equal the scanned minimum (${minShade.toFixed(4)})`);

  console.log(`✓ Tilted-plane illumination bounded by [cos(alt+slope), cos(alt-slope)] across all azimuths, minimum sits exactly opposite the (unique) brightest azimuth (argmax=${argmaxAz}°)`);
}

// ── Test 3: mirroring the ramp's direction (east-rising vs west-rising)
// rotates its illumination-vs-azimuth profile by exactly 180°, i.e. the
// formula's directional response is self-consistent under reflection. ──────
{
  const rows = 12, cols = 12;
  const eastRamp = Array.from({ length: rows }, () => Array.from({ length: cols }, (_, c) => c * 3));
  const westRamp = Array.from({ length: rows }, () => Array.from({ length: cols }, (_, c) => (cols - 1 - c) * 3));
  const altitudeDeg = 45;
  const midIdx = Math.floor(rows / 2) * cols + Math.floor(cols / 2);

  for (let az = 0; az < 360; az += 30) {
    const eastShade = Hillshade.compute(eastRamp, rows, cols, 1, 1, { azimuthDeg: az, altitudeDeg })[midIdx];
    const oppositeShade = Hillshade.compute(westRamp, rows, cols, 1, 1, { azimuthDeg: (az + 180) % 360, altitudeDeg })[midIdx];
    assert(
      Math.abs(eastShade - oppositeShade) < 1e-4,
      `East ramp at az=${az}° (${eastShade.toFixed(4)}) should equal mirrored west ramp at az=${(az + 180) % 360}° (${oppositeShade.toFixed(4)})`
    );
  }
  console.log('✓ Mirroring the slope direction rotates its illumination-vs-azimuth response by exactly 180°');
}

// ── Test 4: masked (null) cells are skipped without crashing; a masked
// cell's presence in the 3x3 neighborhood doesn't blow up its shaded
// neighbors (flat-extrapolation fallback keeps values finite and in-range). ──
{
  const rows = 8, cols = 8;
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => {
    if (r < 2 || c < 2) return null; // masked corridor edge, like generateContourSurface's boundary mask
    return r + c;
  }));
  const shade = Hillshade.compute(grid, rows, cols, 1, 1, { azimuthDeg: 315, altitudeDeg: 45 });
  assert(shade.length === rows * cols, 'Returns one shade value per cell');
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const v = shade[r * cols + c];
      assert(!isNaN(v) && isFinite(v), `Cell (${r},${c}) shade is finite`);
      assert(v >= 0 && v <= 1, `Cell (${r},${c}) shade=${v} is within [0,1]`);
      if (grid[r][c] === null) assert(v === 0, `Masked cell (${r},${c}) left at 0 (caller never reads it, but shouldn't be garbage)`);
    }
  }
  console.log('✓ Masked cells handled without crashing; all shaded cells stay finite and within [0,1]');
}

// ── Test 5: perf smoke — 400x400 (the UI's max gridResolution, index.html
// #gridResolution max="400"). The hillshade pass itself stays cheap even at
// this size (~15ms budget here) — generateContourSurface()'s own grid
// interpolation is the dominant cost at 400x400 (~125ms on a real 3-track
// fixture per the perf investigation that set this max), not hillshading. ──
{
  const rows = 400, cols = 400;
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => Math.sin(r * 0.3) + Math.cos(c * 0.2)));
  // `node --test tests/*.js` runs test files concurrently, so a single
  // timed call is noisy under CPU contention from sibling test files —
  // warm up, take several samples, and assert on the MINIMUM (the sample
  // least polluted by contention), same approach tests/manual/_bench_render_perf.js
  // uses for exactly this reason.
  for (let i = 0; i < 2; i++) Hillshade.compute(grid, rows, cols, 1, 1, { azimuthDeg: 315, altitudeDeg: 45 });
  let minMs = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = process.hrtime.bigint();
    Hillshade.compute(grid, rows, cols, 1, 1, { azimuthDeg: 315, altitudeDeg: 45 });
    minMs = Math.min(minMs, Number(process.hrtime.bigint() - t0) / 1e6);
  }
  assert(minMs < 100, `400x400 hillshade pass completes in well under a frame budget (best of 5: ${minMs.toFixed(3)}ms)`);
  console.log(`✓ 400x400 grid (UI max resolution) hillshades in ${minMs.toFixed(3)}ms (best of 5)`);
}

// ── Test 6: azimuthDeg calibration — a slope whose real downhill direction
// (aspect) is true compass bearing B is brightest when the sun is placed at
// that SAME true bearing B (0=N, 90=E, 180=S, 270=W, clockwise). This pins
// the raw-math-angle-to-compass-bearing conversion inside compute() so it
// can't silently regress — a wrong conversion doesn't break the shading
// math (contrast/slope are unaffected), it just aims the simulated sun at
// the wrong point on screen, which is exactly the kind of bug that's
// invisible in the convention-agnostic Tests 2/3 above. ────────────────────
{
  const rows = 12, cols = 12;
  const mid = Math.floor(rows / 2) * cols + Math.floor(cols / 2);
  const argmaxAzimuth = (grid) => {
    let best = -Infinity, bestAz = null;
    for (let az = 0; az < 360; az++) {
      const shade = Hillshade.compute(grid, rows, cols, 1, 1, { azimuthDeg: az, altitudeDeg: 45 });
      if (shade[mid] > best) { best = shade[mid]; bestAz = az; }
    }
    return bestAz;
  };

  // Peak at the south (low r), downhill/aspect points north (0° true).
  const southPeak = Array.from({ length: rows }, (_, r) => new Array(cols).fill(-r * 3));
  assert.strictEqual(argmaxAzimuth(southPeak), 0, 'A north-facing slope (aspect=0°) is brightest with the sun set to azimuthDeg=0 (true north)');

  // Peak at the west (low c), downhill/aspect points east (90° true).
  const westPeak = Array.from({ length: rows }, () => Array.from({ length: cols }, (_, c) => -c * 3));
  assert.strictEqual(argmaxAzimuth(westPeak), 90, 'An east-facing slope (aspect=90°) is brightest with the sun set to azimuthDeg=90 (true east)');

  // Peak at the south-east (low r, high c), downhill/aspect points NW (315° true)
  // — the default HILLSHADE.azimuthDeg (constants.js), so this is the exact
  // "sun top-left, shadow bottom-right" configuration used by the app.
  const sePeak = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (c - r) * 3));
  assert.strictEqual(argmaxAzimuth(sePeak), 315, 'A NW-facing slope (aspect=315°) is brightest with the sun set to azimuthDeg=315 (true NW) — the app default');
  console.log('✓ azimuthDeg is calibrated to true compass bearing (0=N, 90=E, 315=NW), not a raw math angle');
}

// ── Test 7: shadeValueGrid() — the shared helper map.js and map_exporter.js
// both call — hillshades the RATIO field (percentile rank or linear), not
// the raw value, and its ratioGrid matches what a caller's color fill would
// independently compute from the same inputs. ──────────────────────────────
{
  const rows = 6, cols = 6;
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (r === 0 && c === 0) ? null : r * 10 + c));
  const flatVals = grid.flat().filter(v => v !== null);
  const sortedVals = [...flatVals].sort((a, b) => a - b);
  const minVal = Math.min(...flatVals), maxVal = Math.max(...flatVals);

  const rankFn = (v, sorted) => {
    // Minimal percentile-rank stand-in (same contract as StatsMath.percentileRank).
    let idx = sorted.indexOf(v);
    return idx / (sorted.length - 1);
  };

  const { ratioGrid, shade } = Hillshade.shadeValueGrid(grid, rows, cols, {
    minVal, maxVal, sortedVals, rankFn, exaggeration: 2.5, azimuthDeg: 315, altitudeDeg: 45
  });

  assert.strictEqual(ratioGrid[0][0], null, 'Masked source cell stays null in the ratio grid');
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (r === 0 && c === 0) continue;
      const expectedRatio = rankFn(grid[r][c], sortedVals);
      assert(Math.abs(ratioGrid[r][c] - expectedRatio) < 1e-9, `ratioGrid[${r}][${c}] matches the rank function's own output`);
    }
  }
  assert(shade.length === rows * cols, 'shade array covers every cell');
  assert(shade[1 * cols + 1] > 0, 'An unmasked interior cell gets a real (non-zero-by-default) shade value');
  console.log('✓ shadeValueGrid() hillshades the same ratio field a caller\'s color fill uses, and exposes it via ratioGrid');
}

// ── Test 8: valueRatio() — the single canonical formula now used by map.js,
// map_exporter.js, and buildRatioGrid instead of four independent copies. ──
{
  const sorted = [10, 20, 30, 40, 50];
  assert.strictEqual(Hillshade.valueRatio(30, 10, 50, sorted, (v, s) => s.indexOf(v) / (s.length - 1)), 0.5, 'Uses rankFn when a real sorted-values distribution is given');
  assert.strictEqual(Hillshade.valueRatio(30, 10, 50, undefined, undefined), 0.5, 'Falls back to linear min/max ratio when no rankFn/sortedVals is given (30 is halfway between 10 and 50)');
  assert.strictEqual(Hillshade.valueRatio(5, 10, 10, undefined, undefined), 0.5, 'Degenerate minVal===maxVal falls back to the neutral 0.5 ratio, not division by zero/NaN');
  assert.strictEqual(Hillshade.valueRatio(30, 10, 50, [42], (v, s) => 0.9), 0.5, 'A single-element sortedVals (rank undefined) is treated as "no real distribution" and falls back to linear, ignoring rankFn');
  console.log('✓ valueRatio() is the single ratio formula: percentile rank when available, linear min/max fallback otherwise');
}

// ── Test 9: buildRatioGrid() — valueRatio() applied per-cell, preserving the
// source grid's null mask. ──────────────────────────────────────────────────
{
  const rows = 4, cols = 4;
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (r === 2 && c === 2) ? null : r * 4 + c));
  const ratioGrid = Hillshade.buildRatioGrid(grid, rows, cols, { minVal: 0, maxVal: 15 });
  assert.strictEqual(ratioGrid[2][2], null, 'Masked source cell stays null');
  assert.strictEqual(ratioGrid[0][0], 0, 'Min-value cell ratio is 0');
  assert.strictEqual(ratioGrid[3][3], 1, 'Max-value cell ratio is 1');
  console.log('✓ buildRatioGrid() applies valueRatio() per-cell and preserves the null mask');
}

// ── Test 10: blendLightness() — the single blend formula now used by map.js
// and map_exporter.js instead of two independent copies. strength=0 must
// return the baseline EXACTLY (this is what makes the 0% UI slider position
// a true no-op, not an approximation). ──────────────────────────────────────
{
  assert.strictEqual(Hillshade.blendLightness(0.9, 0, 10, 90), 50, 'strength=0 returns the default baseline (50) exactly, regardless of shade');
  assert.strictEqual(Hillshade.blendLightness(1, 1, 10, 90), 90, 'strength=1, shade=1 returns maxLightness exactly');
  assert.strictEqual(Hillshade.blendLightness(0, 1, 10, 90), 10, 'strength=1, shade=0 returns minLightness exactly');
  assert.strictEqual(Hillshade.blendLightness(1, 0.5, 10, 90), 70, 'strength=0.5 is a linear midpoint between baseline (50) and the full shaded lightness (90): 50+0.5*(90-50)=70');
  assert.strictEqual(Hillshade.blendLightness(1, 1, 10, 90, 20), 90, 'Custom baseLightness only matters when strength<1 — at strength=1 it has no effect');
  assert.strictEqual(Hillshade.blendLightness(1, 0, 10, 90, 20), 20, 'Custom baseLightness is honored at strength=0');
  console.log('✓ blendLightness() linearly interpolates baseline -> shaded lightness, strength=0 exact no-op');
}

// ── Test 11: shadeValueGrid()'s zFactor-based shading is mathematically
// equivalent to the previous implementation, which pre-multiplied a whole
// second "heightGrid" array by `exaggeration` before calling compute() with
// the default zFactor=1. Scaling every height by a constant k before
// computing slope/aspect is identical to computing unscaled and passing
// zFactor=k (slope's magnitude scales linearly with k; aspect, a ratio of
// two quantities both scaled by k, is unchanged) — this pins that equivalence
// so the optimization that dropped the extra array pass can't silently
// change what gets rendered. ─────────────────────────────────────────────────
{
  const rows = 10, cols = 10;
  const grid = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => Math.sin(r * 0.4) + Math.cos(c * 0.3)));
  const minVal = -2, maxVal = 2, exaggeration = 3.7, azimuthDeg = 200, altitudeDeg = 50;

  const { shade: actual } = Hillshade.shadeValueGrid(grid, rows, cols, { minVal, maxVal, exaggeration, azimuthDeg, altitudeDeg });

  // Old approach: build ratioGrid, pre-multiply into a separate heightGrid,
  // shade with the default zFactor=1.
  const ratioGrid = Hillshade.buildRatioGrid(grid, rows, cols, { minVal, maxVal });
  const heightGrid = ratioGrid.map(row => row.map(v => v === null ? null : v * exaggeration));
  const expected = Hillshade.compute(heightGrid, rows, cols, 1, 1, { azimuthDeg, altitudeDeg });

  for (let i = 0; i < actual.length; i++) {
    assert(Math.abs(actual[i] - expected[i]) < 1e-6, `Cell ${i}: zFactor-based shade (${actual[i]}) matches the old pre-multiplied-heightGrid shade (${expected[i]})`);
  }
  console.log('✓ shadeValueGrid()\'s zFactor optimization produces numerically identical output to the old separate-heightGrid approach');
}

console.log('\n============================================================');
console.log('Hillshade Algorithm Test: ALL PASSED');
console.log('============================================================');
