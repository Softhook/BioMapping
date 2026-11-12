/**
 * Bio Mapping 2 — front-page demo.
 *
 * A looping, full-screen film: title over a turning Earth, the hardware, what
 * it does, a dive down to Edinburgh, a fly-through of a real walk whose
 * arousal wall builds up as the walker moves, and an orbit of the finished
 * map. Clicking anywhere opens the project README.
 *
 * Data comes from demo/walk.json (built by demo/bake_demo_data.cjs from the
 * visualiser's public demo walk). The colour scale matches the visualiser:
 * green (calm) → yellow → red (strong response).
 */

const README_URL = 'https://github.com/Softhook/BioMapping#readme';

// ── Timeline (seconds into one loop) ──────────────────────────────────────
const T = {
  title: [0.6, 8],
  hardware: [8.6, 17.4],
  what: [18, 26.6],
  dive: 19.6, // camera flight to Edinburgh starts
  diveSecs: 8,
  fly: 28, // walk replay starts
  flySecs: 52,
  end: [88, 97.5],
  fadeOut: 97,
  loop: 99,
};
const T_OVERVIEW = T.fly + T.flySecs; // walk finished → pull back and orbit
const BLEND_SECS = 5; // chase-cam → orbit blend

// Fly-through captions: [fraction of walk where it appears, title, text]
const CAPTIONS = [
  [0.0, 'A real walk through central Edinburgh.', 'Recorded with Bio Mapping 2, replayed about twenty times faster.'],
  [0.24, 'The wall shows the body’s response.', 'Taller and redder means the skin reacted more strongly. Green is calm.'],
  [0.5, 'Each spike is one moment of arousal.', 'The software finds every quick rise in the skin signal and marks where it happened.'],
  [0.75, 'Ten readings every second, each tied to a place.', 'Walk the same streets with others and shared hotspots start to appear.'],
];

// Look of the arousal wall
const SIGNAL_CAP = 2.5; // phasic µS at which the colour is fully red
const WALL_MIN_M = 1.5;
const WALL_MAX_M = 72;
// side: the camera sits this many degrees round from straight behind, so the
// wall is seen side-on rather than edge-on
const CHASE = { range: 235, pitch: -33, lift: 18, side: 55 };
const ORBIT = { range: 760, pitch: -40, degPerSec: 7 };

// ── Helpers ───────────────────────────────────────────────────────────────
const clamp01 = (x) => Math.min(1, Math.max(0, x));
const smooth = (x) => {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
};
const lerp = (a, b, t) => a + (b - a) * t;
const ratioOf = (v) => clamp01(v / SIGNAL_CAP);
const hueOf = (v) => (1 - ratioOf(v)) * 120; // same ramp as the visualiser
const wallHeight = (v) => WALL_MIN_M + (WALL_MAX_M - WALL_MIN_M) * ratioOf(v) ** 0.7;
const fmtClock = (s) => {
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
};
const fmtDist = (m) => (m < 1000 ? `${Math.round(m)} m` : `${(m / 1000).toFixed(2)} km`);

// ── Page wiring ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const cards = {};
for (const el of document.querySelectorAll('[data-card]')) {
  (cards[el.dataset.card] ??= []).push(el);
}
const show = (name, on) => {
  for (const el of cards[name] || []) el.classList.toggle('on', on);
};

document.addEventListener('click', (e) => {
  if (e.target.closest('#fsBtn')) return;
  window.location.href = README_URL;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') window.location.href = README_URL;
  if (e.key === 'f' || e.key === 'F') toggleFullscreen();
});
function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen?.();
  else document.documentElement.requestFullscreen?.().catch(() => {});
}
$('fsBtn').addEventListener('click', toggleFullscreen);

// ── Walk data ─────────────────────────────────────────────────────────────
const walk = await fetch('demo/walk.json').then((r) => r.json());
const S = walk.samples; // [lat, lon, phasic]
const N = S.length;
const vals = S.map((s) => s[2]);
const heights = vals.map(wallHeight);

// Distance walked up to each sample
const cumDist = new Float64Array(N);
for (let i = 1; i < N; i++) {
  const dLat = ((S[i][0] - S[i - 1][0]) * Math.PI) / 180;
  const dLon = ((S[i][1] - S[i - 1][1]) * Math.PI) / 180;
  const m = ((S[i][0] + S[i - 1][0]) * Math.PI) / 360;
  cumDist[i] = cumDist[i - 1] + 6371000 * Math.hypot(dLat, dLon * Math.cos(m));
}

// Smoothed route and travel heading for the chase camera, so it glides
// instead of following every step.
function movingAverage(arr, half) {
  const out = new Float64Array(arr.length);
  for (let i = 0; i < arr.length; i++) {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(arr.length - 1, i + half); j++) {
      s += arr[j];
      n++;
    }
    out[i] = s / n;
  }
  return out;
}
const camLat = movingAverage(S.map((s) => s[0]), 24);
const camLon = movingAverage(S.map((s) => s[1]), 24);
const rawHeading = new Float64Array(N);
{
  const k = 14;
  let prev = 0;
  for (let i = 0; i < N; i++) {
    const a = Math.max(0, i - k);
    const b = Math.min(N - 1, i + k);
    const dy = camLat[b] - camLat[a];
    const dx = (camLon[b] - camLon[a]) * Math.cos((camLat[i] * Math.PI) / 180);
    let h = dx || dy ? Math.atan2(dx, dy) : prev;
    // unwrap so the average below never jumps across ±π
    while (h - prev > Math.PI) h -= 2 * Math.PI;
    while (h - prev < -Math.PI) h += 2 * Math.PI;
    rawHeading[i] = prev = h;
  }
}
const camHeading = movingAverage(rawHeading, 70);
const at = (arr, u) => {
  const i = Math.min(N - 2, Math.max(0, Math.floor(u)));
  return lerp(arr[i], arr[i + 1], clamp01(u - i));
};

const peaks = walk.peaks.filter((p) => p[1] >= 0.5); // [sampleIndex, amplitude]
const centre = {
  lat: (Math.min(...S.map((s) => s[0])) + Math.max(...S.map((s) => s[0]))) / 2,
  lon: (Math.min(...S.map((s) => s[1])) + Math.max(...S.map((s) => s[1]))) / 2,
};

$('endStats').textContent =
  `${fmtDist(walk.distanceMetres)} · ${Math.round(walk.durationSeconds / 60)} minutes · ${walk.peaks.length} reactions`;

// ── Signal strip (bottom) ─────────────────────────────────────────────────
const signalCanvas = $('signal');
const sctx = signalCanvas.getContext('2d');
function drawSignal(u) {
  const dpr = window.devicePixelRatio || 1;
  const w = signalCanvas.clientWidth;
  const h = signalCanvas.clientHeight;
  if (signalCanvas.width !== Math.round(w * dpr)) {
    signalCanvas.width = Math.round(w * dpr);
    signalCanvas.height = Math.round(h * dpr);
  }
  sctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  sctx.clearRect(0, 0, w, h);
  const cols = Math.max(1, Math.floor(w / 3));
  const per = N / cols;
  const head = u / per;
  for (let c = 0; c < cols; c++) {
    let v = 0;
    for (let i = Math.floor(c * per); i < Math.min(N, Math.floor((c + 1) * per)); i++) v = Math.max(v, vals[i]);
    const bh = Math.max(1.5, (h - 4) * ratioOf(v) ** 0.85);
    const past = c <= head;
    sctx.fillStyle = past ? `hsl(${hueOf(v)} 100% 52%)` : 'rgba(255,255,255,0.13)';
    sctx.fillRect(c * 3, h - bh, 2, bh);
  }
  const x = Math.min(w - 1, head * 3);
  sctx.fillStyle = '#fff';
  sctx.fillRect(x, 0, 1.5, h);
}

// ── Cesium scene ──────────────────────────────────────────────────────────
let viewer = null;
try {
  Cesium.Ion.defaultAccessToken = '';
  viewer = new Cesium.Viewer('globe', {
    baseLayer: new Cesium.ImageryLayer(
      new Cesium.UrlTemplateImageryProvider({
        url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
        maximumLevel: 19,
        credit: 'Esri, Maxar, Earthstar Geographics',
      }),
    ),
    baseLayerPicker: false,
    geocoder: false,
    homeButton: false,
    infoBox: false,
    selectionIndicator: false,
    timeline: false,
    animation: false,
    navigationHelpButton: false,
    sceneModePicker: false,
    fullscreenButton: false,
    creditContainer: document.createElement('div'),
    scene3DOnly: true,
    shouldAnimate: false,
  });
} catch (err) {
  console.warn('3D view unavailable, showing the text cards only:', err);
  viewer = null;
}

let wall = null;
let wallShown = 0; // wall segments currently visible
const spires = [];
const pulses = [];
let walker = null;
let walkerU = 0;

if (viewer) {
  const scene = viewer.scene;
  viewer.useBrowserRecommendedResolution = false;
  viewer.resolutionScale = Math.min(1, 2 / (window.devicePixelRatio || 1));
  // Fixed midsummer midday: steady, flattering light on the buildings
  viewer.clock.currentTime = Cesium.JulianDate.fromIso8601('2026-06-21T12:30:00Z');
  scene.screenSpaceCameraController.enableInputs = false;
  scene.globe.enableLighting = false;
  scene.globe.maximumScreenSpaceError = 1.6;
  scene.globe.tileCacheSize = 400;
  scene.globe.preloadSiblings = true;
  scene.fog.enabled = true;
  scene.fog.density = 0.00012;
  scene.globe.showGroundAtmosphere = true;
  if (scene.sun) scene.sun.show = false;
  if (scene.moon) scene.moon.show = false;
  const base = viewer.imageryLayers.get(0);
  base.brightness = 0.82;
  base.saturation = 0.8;
  base.contrast = 1.08;
  scene.postProcessStages.fxaa.enabled = true;

  // Buildings
  const buildingInstances = [];
  for (const [h, ring] of walk.buildings) {
    const pts = ring.slice();
    if (pts.length > 6 && pts[0] === pts.at(-2) && pts[1] === pts.at(-1)) pts.length -= 2;
    const shade = 0.16 + Math.min(0.12, h / 400);
    try {
      buildingInstances.push(
        new Cesium.GeometryInstance({
          geometry: new Cesium.PolygonGeometry({
            polygonHierarchy: new Cesium.PolygonHierarchy(Cesium.Cartesian3.fromDegreesArray(pts)),
            height: 0,
            extrudedHeight: h,
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT,
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(
              new Cesium.Color(shade * 0.9, shade, shade * 1.25, 0.5),
            ),
          },
        }),
      );
    } catch {
      /* skip a broken footprint */
    }
  }
  if (buildingInstances.length) {
    scene.primitives.add(
      new Cesium.Primitive({
        geometryInstances: buildingInstances,
        appearance: new Cesium.PerInstanceColorAppearance({ translucent: true, closed: true }),
        asynchronous: true,
      }),
    );
  }

  // Faint route on the ground, so the path reads before the wall builds
  viewer.entities.add({
    polyline: {
      positions: Cesium.Cartesian3.fromDegreesArrayHeights(S.flatMap((s) => [s[1], s[0], 0.4])),
      width: 2,
      material: Cesium.Color.WHITE.withAlpha(0.35),
    },
  });

  // Arousal wall: one segment per sample step, revealed as the walker passes
  const wallInstances = [];
  for (let i = 0; i < N - 1; i++) {
    if (cumDist[i + 1] - cumDist[i] < 0.05) continue; // standing still: nothing to draw
    const vm = (vals[i] + vals[i + 1]) / 2;
    wallInstances.push(
      new Cesium.GeometryInstance({
        id: i,
        geometry: new Cesium.WallGeometry({
          positions: Cesium.Cartesian3.fromDegreesArray([S[i][1], S[i][0], S[i + 1][1], S[i + 1][0]]),
          maximumHeights: [heights[i], heights[i + 1]],
          minimumHeights: [0, 0],
          vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
        }),
        attributes: {
          color: Cesium.ColorGeometryInstanceAttribute.fromColor(
            Cesium.Color.fromHsl(hueOf(vm) / 360, 1, 0.5, 0.86),
          ),
          show: new Cesium.ShowGeometryInstanceAttribute(false),
        },
      }),
    );
  }
  wall = scene.primitives.add(
    new Cesium.Primitive({
      geometryInstances: wallInstances,
      appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
      asynchronous: true,
      releaseGeometryInstances: false,
    }),
  );

  // Spikes at detected reactions
  for (const [idx, amp] of peaks) {
    const [lat, lon] = S[idx];
    const base = heights[idx];
    const top = base + 12 + 50 * clamp01(amp / 3);
    const color = Cesium.Color.fromHsl(hueOf(amp) / 360, 1, 0.6, 1);
    const spire = viewer.entities.add({
      show: false,
      polyline: {
        positions: Cesium.Cartesian3.fromDegreesArrayHeights([lon, lat, base, lon, lat, top]),
        width: 7,
        material: new Cesium.PolylineGlowMaterialProperty({ glowPower: 0.28, color }),
      },
      position: Cesium.Cartesian3.fromDegrees(lon, lat, top),
      point: {
        pixelSize: 7,
        color: Cesium.Color.WHITE,
        outlineColor: color,
        outlineWidth: 3,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
    spires.push({ idx, entity: spire });

    if (amp >= 1.2) {
      const pulse = { idx, born: -1 };
      const age = () => (pulse.born < 0 ? 0 : clock - pulse.born);
      const radius = new Cesium.CallbackProperty(() => 6 + 70 * smooth(age() / 1.8), false);
      pulse.entity = viewer.entities.add({
        show: false,
        position: Cesium.Cartesian3.fromDegrees(lon, lat, 0),
        ellipse: {
          semiMajorAxis: radius,
          semiMinorAxis: radius,
          height: 0.6,
          material: new Cesium.ColorMaterialProperty(
            new Cesium.CallbackProperty(() => color.withAlpha(0.55 * (1 - clamp01(age() / 1.8))), false),
          ),
        },
      });
      pulses.push(pulse);
    }
  }

  // The walker: a bright dot riding the top of the wall
  walker = viewer.entities.add({
    show: false,
    position: new Cesium.CallbackProperty(() => {
      const i = Math.min(N - 1, Math.floor(walkerU));
      return Cesium.Cartesian3.fromDegrees(S[i][1], S[i][0], heights[i] + 2);
    }, false),
    point: {
      pixelSize: 15,
      color: Cesium.Color.WHITE,
      outlineColor: Cesium.Color.fromCssColorString('#ff5a3c'),
      outlineWidth: 4,
      disableDepthTestDistance: Number.POSITIVE_INFINITY,
    },
  });
}

// ── Camera choreography ───────────────────────────────────────────────────
const D = Cesium.Math.toRadians;

function spacePose(t) {
  // Looking north across the Earth's curve, which sits low in the frame like
  // a horizon; the planet turns slowly until Edinburgh's longitude comes round.
  const lon = walk.samples[0][1] + 55 - 2.8 * Math.min(t, T.dive);
  return {
    destination: Cesium.Cartesian3.fromDegrees(lon, -8, 7.2e6),
    orientation: { heading: 0, pitch: D(-53), roll: 0 },
  };
}

// Camera pose that looks at `target` from heading/pitch/range, as an
// absolute position + orientation (so flyTo can land exactly on it).
function poseLookingAt(lat, lon, height, heading, pitch, range) {
  const target = Cesium.Cartesian3.fromDegrees(lon, lat, height);
  const enu = Cesium.Transforms.eastNorthUpToFixedFrame(target);
  const cp = Math.cos(pitch);
  const offset = new Cesium.Cartesian3(
    -range * cp * Math.sin(heading),
    -range * cp * Math.cos(heading),
    -range * Math.sin(pitch),
  );
  const destination = Cesium.Matrix4.multiplyByPoint(enu, offset, new Cesium.Cartesian3());
  return { destination, orientation: { heading, pitch, roll: 0 } };
}

function chaseFrame(u) {
  return {
    lat: at(camLat, u),
    lon: at(camLon, u),
    height: CHASE.lift,
    heading: at(camHeading, u) + D(CHASE.side),
    pitch: D(CHASE.pitch),
    range: CHASE.range,
  };
}

function lookAt(f) {
  viewer.camera.lookAt(
    Cesium.Cartesian3.fromDegrees(f.lon, f.lat, f.height),
    new Cesium.HeadingPitchRange(f.heading, f.pitch, f.range),
  );
}

// ── Reveal state ──────────────────────────────────────────────────────────
function setWallShown(count) {
  if (!wall || !wall.ready) return;
  count = Math.max(0, Math.min(N - 1, count));
  if (count === wallShown) return;
  const on = count > wallShown;
  const from = on ? wallShown : count;
  const to = on ? count : wallShown;
  const value = Cesium.ShowGeometryInstanceAttribute.toValue(on);
  for (let i = from; i < to; i++) {
    const attrs = wall.getGeometryInstanceAttributes(i);
    if (attrs) attrs.show = value;
  }
  wallShown = count;
}

function resetScene() {
  setWallShown(0);
  for (const s of spires) s.entity.show = false;
  for (const p of pulses) {
    p.entity.show = false;
    p.born = -1;
  }
  if (walker) walker.show = false;
  walkerU = 0;
}

// ── Main loop ─────────────────────────────────────────────────────────────
// seconds into the current loop (only advances while the tab is visible);
// ?at=40 starts part-way through, handy when checking one section
let clock = Math.max(0, +new URLSearchParams(location.search).get('at') || 0);
let last = performance.now();
let phase = '';
let captionIdx = -1;
let orbitStartHeading = 0;

function enterPhase(name) {
  if (name === phase) return;
  phase = name;
  if (!viewer) return;
  const cam = viewer.camera;
  if (name === 'space') {
    cam.lookAtTransform(Cesium.Matrix4.IDENTITY);
    resetScene();
  } else if (name === 'dive') {
    cam.lookAtTransform(Cesium.Matrix4.IDENTITY);
    const f = chaseFrame(0);
    cam.flyTo({
      ...poseLookingAt(f.lat, f.lon, f.height, f.heading, f.pitch, f.range),
      duration: T.diveSecs,
      easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
    });
  } else if (name === 'fly') {
    cam.cancelFlight();
    walker.show = true;
  } else if (name === 'overview') {
    orbitStartHeading = chaseFrame(N - 1).heading;
    setWallShown(N - 1);
    for (const s of spires) s.entity.show = true;
  }
}

function tick() {
  const now = performance.now();
  clock += Math.min(0.1, (now - last) / 1000);
  last = now;
  if (clock >= T.loop) {
    clock = 0;
    phase = '';
    captionIdx = -1;
  }
  const t = clock;

  // Cards and overlays
  const inside = ([a, b]) => t >= a && t < b;
  show('title', inside(T.title));
  show('hardware', inside(T.hardware));
  show('what', inside(T.what));
  show('fly', t >= T.fly + 0.8 && t < T_OVERVIEW + 1);
  show('end', inside(T.end));
  $('blackout').style.opacity = t < 0.4 || t >= T.fadeOut ? '1' : '0';
  $('progressBar').style.width = `${(100 * t) / T.loop}%`;

  // Walk progress
  const flyT = clamp01((t - T.fly) / T.flySecs);
  const u = flyT * (N - 1);

  // Captions
  const capWanted =
    t >= T.fly + 1.2 && t < T_OVERVIEW - 0.5
      ? CAPTIONS.reduce((k, c, i) => (flyT >= c[0] ? i : k), 0)
      : -1;
  const caption = $('caption');
  if (capWanted !== captionIdx) {
    captionIdx = capWanted;
    caption.classList.remove('on');
    if (capWanted >= 0) {
      setTimeout(() => {
        if (captionIdx !== capWanted) return;
        $('captionTitle').textContent = CAPTIONS[capWanted][1];
        $('captionText').textContent = CAPTIONS[capWanted][2];
        caption.classList.add('on');
      }, 650);
    }
  }

  // Heads-up stats and signal strip
  if (t >= T.fly && t < T_OVERVIEW + 1) {
    const i = Math.min(N - 1, Math.floor(u));
    $('statTime').textContent = fmtClock(i * walk.stepSeconds);
    $('statDist').textContent = fmtDist(cumDist[i]);
    let n = 0;
    for (const p of walk.peaks) if (p[0] <= i) n++;
    $('statPeaks').textContent = String(n);
    drawSignal(u);
  }

  if (viewer) {
    if (t < T.dive) {
      enterPhase('space');
      viewer.camera.setView(spacePose(t));
    } else if (t < T.fly) {
      enterPhase('dive');
    } else if (t < T_OVERVIEW) {
      enterPhase('fly');
      walkerU = u;
      setWallShown(Math.floor(u));
      for (const s of spires) {
        if (!s.entity.show && s.idx <= u) s.entity.show = true;
      }
      for (const p of pulses) {
        if (p.born < 0 && p.idx <= u) {
          p.born = clock;
          p.entity.show = true;
        } else if (p.born >= 0 && clock - p.born > 1.9) {
          p.entity.show = false;
        }
      }
      lookAt(chaseFrame(u));
    } else {
      enterPhase('overview');
      setWallShown(N - 1); // no-op once done; retries if the wall was still loading
      if (walker) walker.show = t < T_OVERVIEW + 2;
      const b = smooth((t - T_OVERVIEW) / BLEND_SECS);
      const c = chaseFrame(N - 1);
      lookAt({
        lat: lerp(c.lat, centre.lat, b),
        lon: lerp(c.lon, centre.lon, b),
        height: lerp(c.height, 10, b),
        heading: orbitStartHeading + D(ORBIT.degPerSec) * (t - T_OVERVIEW) * b,
        pitch: lerp(c.pitch, D(ORBIT.pitch), b),
        range: lerp(c.range, ORBIT.range, b),
      });
    }
  }
}

if (viewer) {
  viewer.scene.preUpdate.addEventListener(tick);
} else {
  const loop = () => {
    tick();
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}
