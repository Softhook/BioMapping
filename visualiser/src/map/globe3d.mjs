/**
 * BioMapping 2.0 - 3D Globe Manager (CesiumJS)
 * Copyright (c) 2026 Christian Nold
 * Licensed under the Bio Mapping Community Licence 1.0.
 *
 * Renders biometric tracks as 3D extruded emotional ribbons/walls and
 * vertical peak spires over 3D terrain and satellite/urban basemaps.
 *
 * GSRGlobeManager is a self-contained, embeddable engine: construct it against a
 * container id, feed it an analysed track via renderData({ drawPoints }), and
 * tear it down with destroy(). It makes no assumptions about owning the whole
 * page — index.html's 3D-surface panel is the host (see src/map/globe3d_view.js).
 * Page chrome (sidebar, help pill) lives in the host, never here. The host always
 * supplies the display points; this class never runs the GPS filter chain.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Module-level tables & helpers
// ─────────────────────────────────────────────────────────────────────────────

// CARTO basemap key resolution is shared via GSRBasemap (src/map/basemap.js),
// loaded before this file — see tests/test_html_wiring.js.

/** basemap id -> factory producing a fresh Cesium imagery provider (no API key required) */
import { GSR_CONST } from '../core/constants.mjs';
import { GSRNotices } from '../core/notices.mjs';
import { ResponseDynamics } from '../signal/response_dynamics.mjs';
import { GSRBasemap } from './basemap.mjs';
import { MapColors } from './map_colors.mjs';

export const BASEMAP_PROVIDERS = {
  satellite: () =>
    new Cesium.UrlTemplateImageryProvider({
      url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
      maximumLevel: 19,
      credit: 'Esri, Maxar, Earthstar Geographics',
    }),
  sentinel: () =>
    new Cesium.UrlTemplateImageryProvider({
      url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
      maximumLevel: 16,
      credit:
        'Sentinel-2 cloudless by EOX IT Services GmbH (Contains modified Copernicus Sentinel data)',
    }),
  nasa: () =>
    new Cesium.UrlTemplateImageryProvider({
      url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
      maximumLevel: 8,
      credit: 'NASA GIBS / Landsat / Blue Marble',
    }),
  osm: () =>
    new Cesium.OpenStreetMapImageryProvider({
      url: 'https://tile.openstreetmap.org/',
    }),
  dark: () =>
    new Cesium.UrlTemplateImageryProvider({
      url: GSRBasemap.cartoTileUrl('dark_all'),
      subdomains: ['a', 'b', 'c', 'd'],
      maximumLevel: 19,
    }),
  positron: () =>
    new Cesium.UrlTemplateImageryProvider({
      url: GSRBasemap.cartoTileUrl('light_all'),
      subdomains: ['a', 'b', 'c', 'd'],
      maximumLevel: 19,
    }),
};

/**
 * Colouring metric -> analyzer per-sample series field. Mirrors DERIVED_METRIC_SERIES
 * in map.js; anything not listed falls back to the raw GSR series.
 */
export const SERIES_FIELD = {
  phasic: 'phasic',
  tonic: 'tonic',
  arousalIndex: 'arousalIndex',
  triIndex: 'triIndex',
  peakDensity: 'peakDensity',
  phasicAUC: 'phasicAUC',
  edasymp: 'edasymp',
  responseDynamics: 'responseDynamics',
  em_fog: 'em_fog',
  emFog: 'em_fog',
};

/**
 * Metrics whose values are an arousal magnitude and so make sense as a wall
 * height. Anything outside this set (raw GSR aside) colours the wall but can't
 * drive its extrusion — the embedded host keeps height on a fixed arousal
 * series (heightMetric) while colour follows whatever the 2D view is showing.
 *
 * EDASymp (0.045–0.25 Hz spectral band power) is a positive continuous arousal
 * magnitude, so it belongs here too: without it the wall falls back to the
 * spiky phasic series, and a smooth EDASymp colour gradient gets a jagged
 * phasic-scr silhouette that looks nothing like the 2D graph. Its µS² values
 * are ~100× smaller than the µS-scale series, so the extrusion is subtle at
 * the default scale — raise the extrusion slider to exaggerate it.
 */
export const HEIGHT_CAPABLE_METRICS = new Set([
  'gsr',
  'phasic',
  'tonic',
  'arousalIndex',
  'triIndex',
  'peakDensity',
  'phasicAUC',
  'edasymp',
]);

/** Unwrap one analyzer series sample ({time,val} | number) to a plain float. */
export const seriesValue = (d) =>
  d && typeof d === 'object' && 'val' in d
    ? d.val
    : typeof d === 'number'
      ? d
      : 0;

/**
 * Resolve the analyzer.raw row field a non-derived colouring metric reads —
 * mirrors map.js's `_getMetricKey` for the OSM/Satellite enrichment fields,
 * plus the two special cases (`gsr` → raw GSR, `hdopQuality` → hdop). Returns
 * null when the metric has no raw-field mapping (e.g. an unknown metric or a
 * derived SERIES_FIELD metric, which callers resolve elsewhere).
 */
export const rawMetricField = (metric) => {
  if (metric === 'gsr') return 'gsr';
  if (metric === 'hdopQuality') return 'hdop';
  if (typeof GSR_CONST !== 'undefined') {
    const tables = [GSR_CONST.OSM_METRICS, GSR_CONST.SATELLITE_METRICS];
    for (const table of tables) {
      if (!Array.isArray(table)) continue;
      for (const m of table) {
        if (m && m.key === metric) return m.field;
      }
    }
  }
  return null;
};

// The arousal wall is thinned to at most this many segments before it is built
// (see _decimateForWall): a walk can carry >10k display points and at the zoom
// that frames the whole track they are tens of points per pixel. Override per
// instance with options.wallMaxSegments (Infinity disables thinning).
export const WALL_MAX_SEGMENTS = 2500;

// ─────────────────────────────────────────────────────────────────────────────
// GSRGlobeManager
// ─────────────────────────────────────────────────────────────────────────────

export class GSRGlobeManager {
  /**
   * @param {string} containerId  DOM id of the element to mount the Cesium viewer in.
   * @param {object} [options]
   * @param {string}  [options.metric='phasic']       initial colouring metric
   * @param {number}  [options.extrusionScale=8.0]    initial wall-height scale
   * @param {boolean} [options.keyboardFlight=true]   bind window WASD/arrow flight keys
   * @param {boolean} [options.doubleClickFly=true]   double-click canvas to fly to point
   * @param {boolean} [options.requestRenderMode=false]  render only on scene change /
   *   explicit requestRender() instead of every frame — big idle-cost win for an
   *   embedded panel.
   * @param {number}  [options.resolutionScale=1.2]     canvas render-resolution
   *   multiplier on top of devicePixelRatio (see initViewer).
   * @param {number}  [options.orbitResolutionScale=0.85]  render-resolution
   *   multiplier while the 360° turntable orbit runs (restored on stop).
   */
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.viewer = null;
    this.options = options;

    // Embedding contract — a host that shares the page (index.html view tab) turns
    // keyboardFlight off so the 3D engine's window key listeners don't fight the 2D view.
    this.keyboardFlight = options.keyboardFlight !== false;
    this.doubleClickFly = options.doubleClickFly !== false;
    this.requestRenderMode = options.requestRenderMode === true;

    // Smoothness bridge for a render-on-demand host. On-demand rendering idles
    // cheaply but makes clock-driven motion — inertia glide, wheel-zoom ramp,
    // camera flights, tile fade-in — visibly steppy, because a frame is only
    // drawn on a discrete scene change. _wakeRenderLoop() drops the scene to
    // continuous rendering from the first interaction and holds it there until
    // ~this long after all camera motion stops, then hands back to on-demand.
    // No-op for a continuously rendering host.
    this._idleRenderMs = options.idleRenderMs || 2200;
    this._idleRenderTimer = null;
    this._wakeHandlers = null;
    this._postRenderRemover = null;

    // Canvas render resolution — see initViewer. A single constant multiplier:
    // varying it per-interaction reallocates Cesium's drawing buffer on every
    // change, and that one-frame stall at the start/end of a gesture read as
    // clunkier than just holding a fixed resolution.
    this._resolutionScale =
      options.resolutionScale > 0 ? options.resolutionScale : 1.2;
    // The 360° turntable is continuous motion for its whole duration — render it
    // softer while it runs (restored in stopOrbit). One resolutionScale write
    // per orbit session, not per frame, so no drawing-buffer thrash.
    this._orbitResolutionScale =
      options.orbitResolutionScale > 0 ? options.orbitResolutionScale : 0.85;

    // Retain cached tiles in memory across pan/orbit gestures to prevent thrashing
    // and eliminate satellite tile reload pop-in when rotating the view.
    this.tileCacheSize =
      options.tileCacheSize > 0 ? options.tileCacheSize : 500;

    // Active track data cache
    this.currentAnalyzer = null;
    this.currentDrawPoints = [];
    this.currentPeaks = [];

    // Configuration & styling
    this.activeColoringMetric = options.metric || 'phasic'; // 'phasic' | 'gsr' | 'tonic' | 'arousalIndex' | 'peakDensity'
    // Wall height is driven by this series, independent of the colour metric —
    // so a host showing a non-magnitude metric (road class, EM fog, HDOP) in 2D
    // still gets a meaningful extrusion in 3D. See _render3DWallAndPath.
    this.heightMetric = options.heightMetric || 'phasic';
    // When the host owns colour normalisation (2D view is the source of truth),
    // it pushes its legend range in here via renderData({ colorRange }); null
    // means "compute my own min/max over the drawn points".
    this.externalColorRange = null;
    this.extrusionScale = options.extrusionScale || 8.0; // Meters of height per metric unit
    this.baseHeight = 2.0; // Minimum base wall height in meters
    this.wallMaxSegments = options.wallMaxSegments || WALL_MAX_SEGMENTS; // wall thinning budget
    this.showPeaks = true;
    this.minPeakQuality = 0.0;
    // The flat clamp-to-ground polyline tracing the walk. Off by default — the
    // 3D view is the extruded wall; the ground trace duplicates it and adds
    // z-fighting shimmer over terrain. Opt in with `{ showGroundPath: true }`.
    this.showGroundPath = options.showGroundPath === true;
    // Mirrors of the 2D sidebar sliders, refreshed from the gpsParams the host
    // passes into renderData(): Track Width (gpsTrackWeight, px) for the ground
    // path, and Peak latency (gpsPeakLatency, s) for shifting peak/hotspot
    // markers to the GPS fix that many seconds earlier — see _latencyCoords()
    // and map.js:_resolveLatencyIndex.
    this.trackWidth = options.trackWidth || 5;
    this.peakLatency = 0;
    // Panel-header layer toggles that mirror the 2D map's. Hotspots are
    // analyzer.memorableEvents (same set the flat map dots use); cluster blobs
    // are the 2D map's already-computed concave hulls, handed in via
    // renderData({ clusterPolygons }) so the 2D view stays the source of truth.
    this.showHotspots = true;
    this.showLabels = true;
    this.showClusters = true;
    this.currentClusterPolygons = [];

    // Entity / primitive collections
    this.trackEntities = [];
    this.wallPrimitive = null;
    this.peakEntities = [];
    this.hotspotEntities = [];
    this.clusterEntities = [];
    this.osmBuildingEntities = [];
    this.scrubEntity = null;
    this.buildingsTileset = null;
    this.buildingPrimitive = null;
    this.cachedOsmJson = null;

    // Batched Primitive Collections for high-performance markers
    this._peakPoints = null;
    this._peakLabels = null;
    this._hotspotLabels = null;

    // Peak interaction — the host registers a callback and this class calls it
    // with the analyzer.peaks index when the user clicks a peak spire, mirroring
    // the 2D map's peak-marker click. See onPeakClick() / _renderPeakSpires().
    this._peakClickCb = null;

    // Scrub-hover interaction — the host registers a callback and this class
    // calls it as (drawPointOrigIdx, {lat, lon}) while the pointer is over the
    // 3D track, or (null) when it leaves. The 3D counterpart of hovering the 2D
    // map path. See onScrubHover() and _setupCameraControls().
    this._scrubHoverCb = null;
    this._scrubHoverLeaveHandler = null;

    // Teardown bookkeeping — every listener this class adds, so destroy() is exact.
    this._keyDownHandler = null;
    this._keyUpHandler = null;
    this._screenSpaceHandler = null;
    this._flightTickRemover = null;
    this._onContextLost = null;
    this._onContextRestored = null;
    this._hoverRaf = 0;
    this._pendingHoverPos = null;
    this._extrusionRaf = 0;

    // Colour LUT cache (Cesium.Color[] mirror of MapColors.getColorLut) + last
    // basemap id, for _render3DWallAndPath and context-restore.
    this._cesiumColorLut = null;
    this._cesiumColorLutKey = null;
    this._currentBasemap = null;

    // 3D Volumetric RF Expanse settings
    this.showRfVolumetric = false;
    this.rfMode = 'triband'; // 'triband' | '815' | '868' | '915' | 'fog'
    this.rfHeight = 25.0; // Volumetric ceiling in meters
    this.rfOpacity = 0.45;
    this.rfPrimitive = null;

    // Orbit camera animation
    this._isOrbiting = false;
    this._orbitRemoveCallback = null;

    // Follow-cam: true while the camera is locked onto the scrub cursor (a
    // Cesium lookAt transform is active and must be released — see
    // followScrub() / releaseFollowScrub()).
    this._followingScrub = false;

    // Automated Track Tour state
    this._isTouring = false;
    this._tourStepTimeout = null;
    this._tourStepIndex = 0;
    this._tourWaypoints = [];
    this._tourCallback = null;

    this.initViewer();
  }

  /**
   * Create a reliable, key-free tile imagery provider for a basemap id.
   * Falls back to OpenStreetMap for an unknown id. See BASEMAP_PROVIDERS.
   */
  _createImageryProvider(type) {
    return (BASEMAP_PROVIDERS[type] || BASEMAP_PROVIDERS.osm)();
  }

  /**
   * Initialize Cesium Viewer with open satellite imagery (no API key required)
   */
  initViewer() {
    if (typeof Cesium === 'undefined') {
      console.error('Cesium library not loaded.');
      return;
    }

    // Disable Cesium Ion default key check warning
    Cesium.Ion.defaultAccessToken = window.BIOMAP_CONFIG?.cesiumIonToken || '';

    try {
      this.viewer = new Cesium.Viewer(this.containerId, {
        baseLayer: false,
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
        vrButton: false,
        creditContainer: document.createElement('div'), // Hide default credit container to manage cleanly
        scene3DOnly: true,
        shadows: false,
        // Render-on-demand for the embedded panel — idle frames cost ~nothing.
        requestRenderMode: this.requestRenderMode,
        maximumRenderTimeChange: this.requestRenderMode ? Infinity : 0.0,
      });
    } catch (err) {
      // WebGL context creation can fail outright (no GPU, blocklisted driver,
      // too many live contexts). Leave this.viewer null — every method guards
      // on it and the host (globe3d_view.activate) shows a degrade message.
      this.viewer = null;
      this._notifyError(err);
      return;
    }

    // Retina/HiDPI sharpness. Cesium's default (useBrowserRecommendedResolution
    // = true) renders the canvas at CSS-pixel size and lets the browser upscale
    // it, which is soft on a >1x display. false makes it honour
    // window.devicePixelRatio; resolutionScale is a further multiplier on top
    // (1.2 = a touch of supersampling over native — crisper walls/labels at a
    // low fragment cost, snappy in motion). Held constant on purpose: see
    // constructor.
    this.viewer.useBrowserRecommendedResolution = false;
    this.viewer.resolutionScale = this._resolutionScale;

    // Set initial ArcGIS satellite basemap immediately
    this.setBasemap('satellite');

    const scene = this.viewer.scene;
    const globe = scene.globe;

    // Fast, lightweight rendering settings
    globe.enableLighting = false;
    globe.depthTestAgainstTerrain = false;
    scene.fog.enabled = true;
    scene.fog.density = 0.0001;

    // Peak circles / labels / hotspot stars flicker against the extruded wall
    // whenever the camera moves (360° orbit, fly-to, drag) with Cesium's
    // logarithmic depth buffer on: the billboard's eye-space depth is recomputed
    // each frame at reduced precision and its position relative to the wall keeps
    // crossing the resolution threshold, so it winks in and out even though
    // disableDepthTestDistance is Infinity. This is a low-altitude urban view —
    // nothing of interest sits beyond a few km — so the plain depth buffer has
    // ample precision and holds the markers rock-steady in motion.
    scene.logarithmicDepthBuffer = false;

    // Strip the space scenery — this is a top-down data view, none of it is
    // useful and each one costs shader passes and slows the first paint.
    if (scene.skyBox) scene.skyBox.show = false;
    if (scene.skyAtmosphere) scene.skyAtmosphere.show = false;
    if (scene.sun) scene.sun.show = false;
    if (scene.moon) scene.moon.show = false;
    scene.backgroundColor = Cesium.Color.fromCssColorString('#0b0c10');
    globe.showGroundAtmosphere = false;
    // Slightly coarser tiles: fewer/faster imagery requests, no visible loss at
    // the altitudes this view uses.
    globe.maximumScreenSpaceError = 2.0;
    // Cache tiles in memory across pan/orbit gestures to prevent network thrashing
    // and eliminate satellite tile reload pop-in when rotating the view.
    globe.tileCacheSize = this.tileCacheSize;
    globe.preloadSiblings = true;

    // Optional Cesium Ion Terrain if token provided
    if (
      Cesium.Ion.defaultAccessToken &&
      typeof Cesium.Terrain !== 'undefined'
    ) {
      try {
        scene.setTerrain(Cesium.Terrain.fromWorldTerrain());
      } catch (err) {
        console.warn('Could not load Cesium World Terrain:', err);
      }
    }

    // Initialize scrub indicator
    this._initScrubEntity();

    // Setup Google Earth style mouse & keyboard flight controls
    this._setupCameraControls();
  }

  /**
   * Configure Google Earth style camera interactions & keyboard flight controls
   */
  _setupCameraControls() {
    const scene = this.viewer.scene;
    const controller = scene.screenSpaceCameraController;

    // Enable full 6-DOF controls
    controller.enableRotate = true;
    controller.enableTranslate = true;
    controller.enableZoom = true;
    controller.enableTilt = true;
    controller.enableLook = true;
    controller.enableCollisionDetection = true;

    // Google Earth fluid inertia settings
    controller.inertiaSpin = 0.85;
    controller.inertiaTranslate = 0.85;
    controller.inertiaZoom = 0.8;

    // Zoom ranges: allow zooming right down to street/ground level
    controller.minimumZoomDistance = 1.0;
    controller.maximumZoomDistance = 40000000.0;

    // Tilt/orbit pivot: Cesium's tilt3D() picks its centre of rotation two
    // different ways — the point under the CURSOR when the drag started (its
    // low-altitude tilt3DOnTerrain path), or the point at the CENTRE OF THE
    // CANVAS (its high-altitude tilt3DOnEllipsoid path, gated on
    // minimumCollisionTerrainHeight, 15 km on WGS84). This view always sits well
    // below 15 km, so the default gave an unpredictable cursor-anchored pivot.
    // Forcing the gate negative keeps tilt on the canvas-centre pivot at every
    // altitude — the predictable Google Earth style orbit. Cost: the same
    // constant also gates terrain collision height-adjustment, so the pivot now
    // rides the ellipsoid (sea level) rather than the terrain surface;
    // negligible on the near-flat urban tracks this view shows, and
    // minimumZoomDistance still stops the camera at the surface.
    controller.minimumCollisionTerrainHeight = -1;

    // Mouse button mappings (Google Earth standard):
    // 1. Left Drag -> Pan / Rotate globe
    controller.rotateEventTypes = [Cesium.CameraEventType.LEFT_DRAG];

    // 2. Right Drag or Wheel -> Smooth Zoom
    controller.zoomEventTypes = [
      Cesium.CameraEventType.RIGHT_DRAG,
      Cesium.CameraEventType.WHEEL,
      Cesium.CameraEventType.PINCH,
    ];

    // 3. Middle Click Drag OR Shift+Left Drag OR Ctrl+Left Drag -> 3D Tilt & Orbit
    controller.tiltEventTypes = [
      Cesium.CameraEventType.MIDDLE_DRAG,
      Cesium.CameraEventType.PINCH,
      {
        eventType: Cesium.CameraEventType.LEFT_DRAG,
        modifier: Cesium.KeyboardEventModifier.SHIFT,
      },
      {
        eventType: Cesium.CameraEventType.LEFT_DRAG,
        modifier: Cesium.KeyboardEventModifier.CTRL,
      },
      {
        eventType: Cesium.CameraEventType.RIGHT_DRAG,
        modifier: Cesium.KeyboardEventModifier.CTRL,
      },
    ];

    // 4. Alt + Left Drag -> Free look
    controller.lookEventTypes = [
      {
        eventType: Cesium.CameraEventType.LEFT_DRAG,
        modifier: Cesium.KeyboardEventModifier.ALT,
      },
    ];

    // 5. Canvas click handlers — bound to the viewer's own canvas, never
    // document — kept in _screenSpaceHandler for destroy().
    this._screenSpaceHandler = new Cesium.ScreenSpaceEventHandler(scene.canvas);

    // 5a. LEFT_CLICK on a peak spire -> report its analyzer.peaks index to the
    // host, the 3D equivalent of clicking a peak marker on the 2D map. Only
    // fires on a click without a meaningful drag, so it doesn't fight camera
    // rotation. Non-peak clicks are ignored (camera nav still works).
    this._screenSpaceHandler.setInputAction((click) => {
      if (!this._peakClickCb) return;
      const picked = scene.pick(click.position);
      const idx = picked?.id?._biomapPeakIndex;
      if (typeof idx === 'number') {
        this._peakClickCb(idx, { x: click.position.x, y: click.position.y });
      }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    // 5b. Double-Click to fly to point (Google Earth style).
    if (this.doubleClickFly) {
      this._screenSpaceHandler.setInputAction((click) => {
        const ray = this.viewer.camera.getPickRay(click.position);
        const targetPos = scene.globe.pick(ray, scene);
        if (targetPos) {
          const cartographic = Cesium.Cartographic.fromCartesian(targetPos);
          // cartographic.height is the terrain elevation at the picked point
          // (globe.pick hits the terrain surface). Add it so the camera never
          // lands inside a hillside when zooming into steep terrain.
          const terrainHeight = cartographic.height || 0;
          const curHeight = this.viewer.camera.positionCartographic.height;
          const targetHeight = Math.max(
            terrainHeight + 150.0,
            curHeight * 0.45,
          );
          this.viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromRadians(
              cartographic.longitude,
              cartographic.latitude,
              targetHeight,
            ),
            duration: 1.2,
          });
        }
      }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    }

    // 5c. MOUSE_MOVE over the 3D track -> report the nearest drawPoint's series
    // index to the host, the 3D counterpart of hovering the 2D map path, and
    // dynamically update the cursor when hovering peaks (pointer), the track (crosshair),
    // or the globe surface (grab / grabbing).
    this._pendingHoverPos = null;
    this._hoverRaf = 0;
    this._isDraggingGlobe = false;
    const raf =
      typeof window !== 'undefined' && window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : (fn) => setTimeout(fn, 16);
    const runHoverPick = () => {
      this._hoverRaf = 0;
      const pos = this._pendingHoverPos;
      this._pendingHoverPos = null;
      if (!pos) return;

      let isPeak = false;
      try {
        const picked = scene.pick(pos);
        isPeak = Boolean(
          picked?.id && typeof picked.id._biomapPeakIndex === 'number',
        );
      } catch (_) {}

      const hit = this._pickTrackPoint(pos);
      if (this._scrubHoverCb) {
        this._scrubHoverCb(
          hit ? hit.origIdx : null,
          hit ? { lat: hit.lat, lon: hit.lon } : undefined,
        );
      }

      if (scene.canvas?.style) {
        if (this._isDraggingGlobe) {
          scene.canvas.style.cursor = 'grabbing';
        } else if (isPeak) {
          scene.canvas.style.cursor = 'pointer';
        } else if (hit) {
          scene.canvas.style.cursor = 'crosshair';
        } else {
          scene.canvas.style.cursor = 'grab';
        }
      }
    };
    this._screenSpaceHandler.setInputAction((movement) => {
      this._pendingHoverPos = {
        x: movement.endPosition.x,
        y: movement.endPosition.y,
      };
      if (!this._hoverRaf) this._hoverRaf = raf(runHoverPick);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    this._canvasPointerDownHandler = () => {
      this._isDraggingGlobe = true;
      if (scene.canvas?.style) scene.canvas.style.cursor = 'grabbing';
    };
    this._canvasPointerUpHandler = () => {
      this._isDraggingGlobe = false;
      if (scene.canvas?.style) scene.canvas.style.cursor = 'grab';
    };
    this._windowPointerUpHandler = () => {
      if (this._isDraggingGlobe) {
        this._isDraggingGlobe = false;
        if (scene.canvas?.style) scene.canvas.style.cursor = 'grab';
      }
    };

    if (scene.canvas && typeof scene.canvas.addEventListener === 'function') {
      scene.canvas.addEventListener(
        'pointerdown',
        this._canvasPointerDownHandler,
      );
      scene.canvas.addEventListener('pointerup', this._canvasPointerUpHandler);
    }
    if (
      typeof window !== 'undefined' &&
      typeof window.addEventListener === 'function'
    ) {
      window.addEventListener('pointerup', this._windowPointerUpHandler);
    }

    // The pointer leaving the canvas entirely fires no MOUSE_MOVE — clear the
    // hover explicitly so the graph scrubber doesn't stick and restore default cursor.
    this._scrubHoverLeaveHandler = () => {
      this._isDraggingGlobe = false;
      if (scene.canvas?.style) scene.canvas.style.cursor = 'default';
      if (this._scrubHoverCb) this._scrubHoverCb(null);
    };
    if (scene.canvas && typeof scene.canvas.addEventListener === 'function') {
      scene.canvas.addEventListener('mouseleave', this._scrubHoverLeaveHandler);
    }

    // 6. Real-time WASD / Arrow Key flying controls (opt-out for shared-page hosts)
    if (this.keyboardFlight) {
      this._setupKeyboardFlight();
    }

    // 7. Render-on-demand smoothness bridge (see _wakeRenderLoop). Pointer/wheel
    // input on the canvas starts a continuous-render burst; a per-frame camera
    // watcher keeps it alive for as long as the camera is actually moving
    // (inertia tail, flyTo, keyboard flight), then the idle timer retires it.
    if (this.requestRenderMode) {
      const canvas = scene.canvas;
      this._wakeHandlers = ['pointerdown', 'wheel'].map((type) => {
        const h = () => this._wakeRenderLoop();
        canvas.addEventListener(type, h, { passive: true });
        return { type, h };
      });
      let lastCam = null;
      this._postRenderRemover = scene.postRender.addEventListener(() => {
        const p = this.viewer.camera.positionWC;
        if (lastCam && Cesium.Cartesian3.equalsEpsilon(p, lastCam, 1e-9))
          return;
        lastCam = Cesium.Cartesian3.clone(p, lastCam);
        this._wakeRenderLoop();
      });
    }

    // 8. WebGL context loss/restore. A long-lived embedded viewer can lose its
    // GL context (GPU reset, tab backgrounded on some drivers, too many live
    // contexts). Without this the canvas just freezes black. preventDefault on
    // 'lost' lets the browser hand the context back; on 'restored' rebuild the
    // scene contents Cesium can't restore itself (our raw primitives).
    this._onContextLost = (e) => {
      if (e?.preventDefault) e.preventDefault();
    };
    this._onContextRestored = () => {
      if (!this.viewer) return;
      try {
        this.setBasemap(this._currentBasemap || 'satellite');
        this._refreshTrack();
        this._requestRender();
      } catch (err) {
        this._notifyError(err);
      }
    };
    scene.canvas.addEventListener(
      'webglcontextlost',
      this._onContextLost,
      false,
    );
    scene.canvas.addEventListener(
      'webglcontextrestored',
      this._onContextRestored,
      false,
    );

    // 9. Camera pitch clamping: constrain camera pitch so the view can never tilt
    // completely level with the ground (0° / horizon) or into the sky (>0°),
    // which breaks the ground-intersection ray and makes it very difficult to
    // tilt back down. Clamped between -89.9° (top-down) and -10.0° (low-angle ground).
    if (
      scene.preRender &&
      typeof scene.preRender.addEventListener === 'function'
    ) {
      this._pitchClampRemover = scene.preRender.addEventListener(() =>
        this._enforceCameraPitchBounds(),
      );
    }
  }

  /**
   * Drop the scene to continuous rendering and (re)arm the idle timer that hands
   * it back to render-on-demand once camera motion has settled. No-op unless the
   * host asked for requestRenderMode, and never fights a running 360° orbit
   * (which owns the render loop itself). See constructor notes.
   */
  _wakeRenderLoop() {
    if (!this.requestRenderMode || this._isOrbiting || !this.viewer) return;
    const scene = this.viewer.scene;
    if (scene.requestRenderMode) scene.requestRenderMode = false;
    if (this._idleRenderTimer) clearTimeout(this._idleRenderTimer);
    this._idleRenderTimer = setTimeout(() => {
      this._idleRenderTimer = null;
      if (this.viewer && !this._isOrbiting)
        this.viewer.scene.requestRenderMode = true;
    }, this._idleRenderMs);
  }

  /**
   * Smooth WASD / Arrow Keys flight navigation
   */
  _setupKeyboardFlight() {
    const flags = {
      moveForward: false,
      moveBackward: false,
      moveUp: false,
      moveDown: false,
      moveLeft: false,
      moveRight: false,
      yawLeft: false,
      yawRight: false,
    };

    const getFlagForKey = (code) => {
      switch (code) {
        case 'KeyW':
        case 'ArrowUp':
          return 'moveForward';
        case 'KeyS':
        case 'ArrowDown':
          return 'moveBackward';
        case 'KeyA':
        case 'ArrowLeft':
          return 'moveLeft';
        case 'KeyD':
        case 'ArrowRight':
          return 'moveRight';
        case 'KeyR':
        case 'PageUp':
          return 'moveUp';
        case 'KeyF':
        case 'PageDown':
          return 'moveDown';
        case 'KeyQ':
          return 'yawLeft';
        case 'KeyE':
          return 'yawRight';
        default:
          return null;
      }
    };

    // Listeners are stored as instance refs so destroy() can remove them exactly.
    this._keyDownHandler = (e) => {
      if (
        ['INPUT', 'TEXTAREA', 'SELECT'].includes(
          document.activeElement?.tagName,
        )
      )
        return;
      const flag = getFlagForKey(e.code);
      if (flag) {
        flags[flag] = true;
        e.preventDefault();
      } else if (e.code === 'KeyN') {
        this.resetNorth();
      }
    };
    this._keyUpHandler = (e) => {
      const flag = getFlagForKey(e.code);
      if (flag) {
        flags[flag] = false;
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', this._keyDownHandler);
    window.addEventListener('keyup', this._keyUpHandler);

    // Animate camera on each frame
    const flightTick = () => {
      const camera = this.viewer.camera;
      const cameraHeight = camera.positionCartographic.height;
      const moveRate = Math.max(2.0, cameraHeight * 0.15);
      const rotateRate = 0.02;

      if (flags.moveForward) camera.moveForward(moveRate);
      if (flags.moveBackward) camera.moveBackward(moveRate);
      if (flags.moveUp) camera.moveUp(moveRate * 0.8);
      if (flags.moveDown) camera.moveDown(moveRate * 0.8);
      if (flags.moveLeft) camera.moveLeft(moveRate);
      if (flags.moveRight) camera.moveRight(moveRate);
      if (flags.yawLeft) camera.lookLeft(rotateRate);
      if (flags.yawRight) camera.lookRight(rotateRate);
      if (this.requestRenderMode) this.viewer.scene.requestRender();
    };
    this._flightTickRemover =
      this.viewer.clock.onTick.addEventListener(flightTick);
  }

  /**
   * Tear down the viewer and every listener/primitive this manager created.
   * Safe to call more than once. Required by any host that mounts and unmounts
   * the 3D view repeatedly (e.g. an index.html view tab).
   */
  destroy() {
    this.stopTour();
    this.stopOrbit();
    this.releaseFollowScrub();
    this.clearAll();

    const canvas = this.viewer?.scene?.canvas;
    if (this._scrubHoverLeaveHandler && canvas) {
      canvas.removeEventListener('mouseleave', this._scrubHoverLeaveHandler);
    }
    if (this._canvasPointerDownHandler && canvas) {
      canvas.removeEventListener('pointerdown', this._canvasPointerDownHandler);
    }
    if (this._canvasPointerUpHandler && canvas) {
      canvas.removeEventListener('pointerup', this._canvasPointerUpHandler);
    }
    if (this._windowPointerUpHandler && typeof window !== 'undefined') {
      window.removeEventListener('pointerup', this._windowPointerUpHandler);
    }
    this._canvasPointerDownHandler = null;
    this._canvasPointerUpHandler = null;
    this._windowPointerUpHandler = null;
    this._scrubHoverLeaveHandler = null;
    this._scrubHoverCb = null;

    if (canvas) {
      if (this._onContextLost)
        canvas.removeEventListener(
          'webglcontextlost',
          this._onContextLost,
          false,
        );
      if (this._onContextRestored)
        canvas.removeEventListener(
          'webglcontextrestored',
          this._onContextRestored,
          false,
        );
    }
    this._onContextLost = null;
    this._onContextRestored = null;
    if (typeof window !== 'undefined' && window.cancelAnimationFrame) {
      if (this._hoverRaf) window.cancelAnimationFrame(this._hoverRaf);
      if (this._extrusionRaf) window.cancelAnimationFrame(this._extrusionRaf);
    }
    this._hoverRaf = 0;
    this._extrusionRaf = 0;
    this._pendingHoverPos = null;

    if (this._keyDownHandler) {
      window.removeEventListener('keydown', this._keyDownHandler);
      this._keyDownHandler = null;
    }
    if (this._keyUpHandler) {
      window.removeEventListener('keyup', this._keyUpHandler);
      this._keyUpHandler = null;
    }
    if (this._flightTickRemover) {
      this._flightTickRemover();
      this._flightTickRemover = null;
    }
    if (this._idleRenderTimer) {
      clearTimeout(this._idleRenderTimer);
      this._idleRenderTimer = null;
    }
    if (this._postRenderRemover) {
      this._postRenderRemover();
      this._postRenderRemover = null;
    }
    if (this._pitchClampRemover) {
      this._pitchClampRemover();
      this._pitchClampRemover = null;
    }
    if (this._wakeHandlers && this.viewer?.scene?.canvas) {
      const canvas = this.viewer.scene.canvas;
      this._wakeHandlers.forEach(({ type, h }) => {
        canvas.removeEventListener(type, h);
      });
    }
    this._wakeHandlers = null;
    if (this._screenSpaceHandler && !this._screenSpaceHandler.isDestroyed()) {
      this._screenSpaceHandler.destroy();
    }
    this._screenSpaceHandler = null;
    this._peakClickCb = null;

    if (this.viewer && !this.viewer.isDestroyed()) {
      if (this._peakPoints && this.viewer.scene?.primitives) {
        this.viewer.scene.primitives.remove(this._peakPoints);
      }
      if (this._peakLabels && this.viewer.scene?.primitives) {
        this.viewer.scene.primitives.remove(this._peakLabels);
      }
      if (this._hotspotLabels && this.viewer.scene?.primitives) {
        this.viewer.scene.primitives.remove(this._hotspotLabels);
      }
      this.viewer.destroy();
    }
    this._peakPoints = null;
    this._peakLabels = null;
    this._hotspotLabels = null;
    this.viewer = null;
    this.currentAnalyzer = null;
    this.currentDrawPoints = [];
    this.currentPeaks = [];
    if (this._metricSeriesCache) this._metricSeriesCache.clear();
    this._mc = null;
    this._clusterBlobSig = null;
  }

  /** Surface a recoverable problem to the user via GSRNotices, falling back to console. */
  _notifyWarn(message) {
    if (typeof GSRNotices !== 'undefined') GSRNotices.warn(message, 'globe3d');
    else console.warn('[globe3d]', message);
  }

  /** Surface an unexpected error to the user via GSRNotices, falling back to console. */
  _notifyError(err) {
    if (typeof GSRNotices !== 'undefined') GSRNotices.report(err, 'globe3d');
    else console.error('[globe3d]', err);
  }

  /**
   * Constrain camera pitch within [-89.9°, -10.0°] so the view cannot tilt
   * completely level with the ground (0° / horizon) or into the sky (>0°),
   * which causes ray intersection with the globe to fail and makes it very
   * difficult or impossible to tilt back down.
   */
  _enforceCameraPitchBounds() {
    if (!this.viewer?.camera || this._isOrbiting) return;
    const camera = this.viewer.camera;
    const pitch = camera.pitch;
    if (typeof pitch !== 'number' || isNaN(pitch)) return;

    // Runs on every preRender frame — compute the fixed bounds once.
    if (this._minPitchRad === undefined) {
      const toRad = (deg) => {
        if (
          typeof Cesium !== 'undefined' &&
          Cesium.Math &&
          typeof Cesium.Math.toRadians === 'function'
        ) {
          const val = Cesium.Math.toRadians(deg);
          if (typeof val === 'number') return val;
        }
        return (deg * Math.PI) / 180.0;
      };
      this._minPitchRad = toRad(-89.9);
      this._maxPitchRad = toRad(-10.0);
    }
    const MIN_PITCH_RAD = this._minPitchRad;
    const MAX_PITCH_RAD = this._maxPitchRad;

    if (pitch > MAX_PITCH_RAD || pitch < MIN_PITCH_RAD) {
      const clampedPitch = Math.max(
        MIN_PITCH_RAD,
        Math.min(MAX_PITCH_RAD, pitch),
      );
      camera.setView({
        orientation: {
          heading: camera.heading,
          pitch: clampedPitch,
          roll: 0.0,
        },
      });
    }
  }

  /**
   * Reset camera heading to 0° True North
   */
  resetNorth() {
    if (!this.viewer) return;
    this._wakeRenderLoop();
    const camera = this.viewer.camera;
    camera.flyTo({
      destination: camera.position,
      orientation: {
        heading: 0.0,
        pitch: camera.pitch,
        roll: 0.0,
      },
      duration: 0.8,
    });
  }

  /**
   * Switch perspective preset ('3d' | 'top')
   */
  setViewPerspective(mode) {
    if (!this.viewer) return;
    this.stopTour();
    this._wakeRenderLoop();
    const camera = this.viewer.camera;
    const pitchDeg = mode === 'top' ? -89.9 : -45.0; // top-down 2D vs isometric 3D

    if (this.currentDrawPoints && this.currentDrawPoints.length > 0) {
      const positions = this.currentDrawPoints.map((p) =>
        Cesium.Cartesian3.fromDegrees(p.lon, p.lat),
      );
      const boundingSphere = Cesium.BoundingSphere.fromPoints(positions);
      const pitch = Cesium.Math.toRadians(pitchDeg);
      const heading = camera.heading;
      const range = Math.max(boundingSphere.radius * 2.2, 350.0);

      this.viewer.camera.flyToBoundingSphere(boundingSphere, {
        offset: new Cesium.HeadingPitchRange(heading, pitch, range),
        duration: 0.8,
      });
    } else {
      camera.flyTo({
        destination: camera.position,
        orientation: {
          heading: camera.heading,
          pitch: Cesium.Math.toRadians(pitchDeg),
          roll: 0.0,
        },
        duration: 0.8,
      });
    }
  }
  setBasemap(type) {
    if (!this.viewer) return;
    const layers = this.viewer.imageryLayers;
    // Build the new provider BEFORE dropping the old layer, so a bad tile URL /
    // provider ctor throw leaves the current imagery on screen rather than a
    // blank globe.
    let provider;
    try {
      provider = this._createImageryProvider(type);
    } catch (_err) {
      this._notifyWarn('Could not switch basemap — keeping the current one.');
      return;
    }
    layers.removeAll();
    if (provider) {
      layers.addImageryProvider(provider);
      this._currentBasemap = type;
    }
    this._requestRender();
    if (typeof this.onBasemapChange === 'function') {
      try {
        this.onBasemapChange(type);
      } catch (_e) {
        /* ignore */
      }
    }
  }

  /**
   * Initialize the 3D scrub marker — a black dot with a white ring, matching
   * the 2D map's .scrub-dot (--accent-primary #111111), including its
   * `scrub-pulse` animation: an eased scale 0.8<->1.2 bounce, 1s each way.
   *
   * Cost: the pixelSize CallbackProperty is a handful of float ops, run once
   * per frame ONLY while this entity is showing and the scene is rendering.
   * In-app the scene already renders continuously while the globe is visible
   * (requestRenderMode:false) and deactivate() parks the render loop
   * (useDefaultRenderLoop=false) the moment the 2D map is shown — so this adds
   * no frames and nothing at all when the globe is hidden. Cesium's
   * PointVisualizer skips hidden entities, so it's also free whenever the
   * scrub dot itself is not on screen.
   */
  _initScrubEntity() {
    const basePx = 12;
    const pulse = () => {
      const t = (Date.now() % 2000) / 2000; // 0..1 over 2s
      const tri = t < 0.5 ? t * 2 : (1 - t) * 2; // 0..1..0
      const eased = tri * tri * (3 - 2 * tri); // smoothstep, ~CSS ease
      return basePx * (0.8 + eased * 0.4); // 0.8x..1.2x
    };
    this.scrubEntity = this.viewer.entities.add({
      id: 'biomap-scrub-marker',
      show: false,
      position: Cesium.Cartesian3.ZERO,
      point: {
        // CSS equivalent: `animation: scrub-pulse 1s infinite alternate`.
        pixelSize: new Cesium.CallbackProperty(pulse, false),
        color: Cesium.Color.fromCssColorString('#111111'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  /**
   * Update scrub cursor position in 3D
   */
  setScrubPosition(lat, lon, height = 0) {
    if (!this.scrubEntity) return;
    if (isNaN(lat) || isNaN(lon)) {
      this.scrubEntity.show = false;
      return;
    }

    let resolvedHeight = height;
    if (
      (resolvedHeight == null || resolvedHeight === 0) &&
      this.currentDrawPoints &&
      this.currentDrawPoints.length > 0
    ) {
      resolvedHeight = this._getTrackHeightAt(lat, lon);
    }

    let terrainAlt = 0;
    try {
      if (
        this.viewer?.scene?.globe &&
        typeof this.viewer.scene.globe.getHeight === 'function'
      ) {
        const carto = Cesium.Cartographic.fromDegrees(lon, lat);
        const h = this.viewer.scene.globe.getHeight(carto);
        if (typeof h === 'number' && isFinite(h)) terrainAlt = Math.max(0, h);
      }
    } catch (_e) {}

    const pos = Cesium.Cartesian3.fromDegrees(
      lon,
      lat,
      terrainAlt + Math.max(0, resolvedHeight) + 2.5,
    );
    this.scrubEntity.position = pos;
    this.scrubEntity.show = true;
  }

  /**
   * Resolve extrusion wall height at a given lat/lon based on closest drawn track point.
   */
  _getTrackHeightAt(lat, lon) {
    if (!this.currentDrawPoints || this.currentDrawPoints.length === 0)
      return this.baseHeight || 2.0;
    let closest = null;
    let minD = Infinity;
    for (let i = 0; i < this.currentDrawPoints.length; i++) {
      const p = this.currentDrawPoints[i];
      const d = (p.lat - lat) ** 2 + (p.lon - lon) ** 2;
      if (d < minD) {
        minD = d;
        closest = p;
      }
    }
    if (!closest || closest.origIdx == null) return this.baseHeight || 2.0;
    return this._getPointHeight(closest.origIdx);
  }

  /**
   * Calculate 3D wall height for a single sample index.
   */
  _getPointHeight(origIdx) {
    if (origIdx == null || !this.currentAnalyzer) return this.baseHeight || 2.0;
    const metric = this.activeColoringMetric;
    const heightMetric = HEIGHT_CAPABLE_METRICS?.has(metric)
      ? metric
      : this.heightMetric || 'phasic';
    const series = this._getMetricSeries(this.currentAnalyzer, heightMetric);
    const rawVal = series ? series[origIdx] : 0;
    const extScale = this.extrusionScale || 8.0;
    const baseH = this.baseHeight || 2.0;
    return baseH + Math.max(0, seriesValue(rawVal)) * extScale;
  }

  /**
   * Register a callback fired as (peakIndex, {x, y}) when the user clicks a
   * peak spire — the 3D counterpart of a peak-marker click on the 2D map.
   * peakIndex is the index into analyzer.peaks; {x, y} is the click position
   * within the canvas so the host can place its popup. See globe3d_view.js.
   */
  onPeakClick(cb) {
    this._peakClickCb = typeof cb === 'function' ? cb : null;
  }

  /**
   * Register a callback fired as (drawPointOrigIdx, {lat, lon}) while the
   * pointer is over the 3D track, or (null) when it leaves — the 3D
   * counterpart of hovering the 2D map path. See _setupCameraControls() 5c.
   */
  onScrubHover(cb) {
    this._scrubHoverCb = typeof cb === 'function' ? cb : null;
  }

  /**
   * Ellipsoid-pick at a canvas position, then return the nearest drawn track
   * point ({origIdx, lat, lon}) when the pointer is within a camera-height
   * scaled radius of the line, else null.
   */
  _pickTrackPoint(windowPos) {
    if (!this.viewer || !windowPos || this.currentDrawPoints.length === 0)
      return null;
    const scene = this.viewer.scene;
    const cart = this.viewer.camera.pickEllipsoid(
      windowPos,
      scene.globe.ellipsoid,
    );
    if (!cart) return null;
    const carto = Cesium.Cartographic.fromCartesian(cart);
    const lat = Cesium.Math.toDegrees(carto.latitude);
    const lon = Cesium.Math.toDegrees(carto.longitude);

    const R = 6378137;
    const cosLat = Math.cos(carto.latitude);
    const deg2rad = Math.PI / 180;
    let best = null;
    let bestSq = Infinity;
    for (let i = 0; i < this.currentDrawPoints.length; i++) {
      const p = this.currentDrawPoints[i];
      const dx = (p.lon - lon) * deg2rad * cosLat * R;
      const dy = (p.lat - lat) * deg2rad * R;
      const dSq = dx * dx + dy * dy;
      if (dSq < bestSq) {
        bestSq = dSq;
        best = p;
      }
    }
    if (!best) return null;

    const camH = this.viewer.camera.positionCartographic.height || 1000;
    const thresh = Math.max(15, camH * 0.03);
    if (bestSq > thresh * thresh) return null;
    return { origIdx: best.origIdx, lat: best.lat, lon: best.lon };
  }

  /**
   * Follow-cam: recentre the camera on the scrub cursor, keeping the user's
   * current heading, pitch and distance. Driven from a graph hover (see
   * globe3d_view.js _onScrub). No-op while orbiting — the orbit owns the
   * camera. lookAt() installs a reference-frame transform that stays until
   * releaseFollowScrub() clears it, so ordinary mouse-drag rotation is paused
   * for as long as the graph is being scrubbed.
   */
  followScrub(lat, lon) {
    if (!this.viewer || this._isOrbiting || isNaN(lat) || isNaN(lon)) return;
    const camera = this.viewer.camera;
    const target = Cesium.Cartesian3.fromDegrees(lon, lat);
    const range = Math.max(
      50,
      Cesium.Cartesian3.distance(camera.positionWC, target),
    );
    camera.lookAt(
      target,
      new Cesium.HeadingPitchRange(camera.heading, camera.pitch, range),
    );
    this._followingScrub = true;
    this._wakeRenderLoop();
    this._requestRender();
  }

  /** Release the follow-cam lookAt transform installed by followScrub(). */
  releaseFollowScrub() {
    if (!this.viewer || !this._followingScrub) return;
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this._followingScrub = false;
    this._requestRender();
  }

  /**
   * Render a BioMapping track in 3D.
   * @param {GSRAnalyzer} analyzer  Analysed track instance.
   * @param {object} [gpsParams]    The host's GPS params object (from
   *                                GSRStorage.buildGpsParams). This class never
   *                                runs the GPS chain — the host supplies
   *                                `opts.drawPoints` — but two fields are read so
   *                                the 3D view tracks the 2D sidebar sliders:
   *                                `trackWeight` (ground-path width, px) and
   *                                `peakLatency` (peak/hotspot marker time shift,
   *                                s).
   * @param {object} [opts]
   * @param {string}  [opts.colorMetric]  Colour the wall/path by this metric instead of
   *                                      the manager's own activeColoringMetric — the
   *                                      embedded host passes the 2D view's active metric
   *                                      so both surfaces match.
   * @param {{min:number,max:number}} [opts.colorRange]  Host-owned colour normalisation
   *                                      range (the 2D legend's min/max). When given, the
   *                                      wall isn't re-normalised over its own points.
   * @param {Array}   [opts.drawPoints]  Display points from the host (the exact
   *                                     array the 2D map drew). Required — at least
   *                                     2 points, or nothing renders.
   * @param {Array}   [opts.clusterPolygons]  Spatial-cluster hulls the 2D map has
   *                                     already computed — [{ ring:[[lat,lon],…],
   *                                     color, fillOpacity }]. Drawn as ground
   *                                     blobs when the Clusters toggle is on.
   * @param {boolean} [opts.isPreview=false]  Suppress the initial fly-to-track.
   */
  renderData(analyzer, gpsParams, opts = {}) {
    if (!this.viewer) return;
    // analyze() may have refilled the analyzer's series buffers in place since
    // the last render — drop the memo so this rebuild reads fresh values.
    this._invalidateMetricSeriesCache();
    if (!analyzer?.raw || analyzer.raw.length === 0) {
      this.clearAll();
      this.currentAnalyzer = null;
      this.currentDrawPoints = [];
      this.currentPeaks = [];
      this._requestRender();
      return;
    }

    const {
      drawPoints: providedDrawPoints,
      isPreview = false,
      colorMetric,
      colorRange,
      clusterPolygons,
    } = opts;
    this.currentClusterPolygons = Array.isArray(clusterPolygons)
      ? clusterPolygons
      : [];

    if (colorMetric) this.activeColoringMetric = colorMetric;
    this.externalColorRange =
      colorRange && isFinite(colorRange.min) && isFinite(colorRange.max)
        ? colorRange
        : null;

    // Track the 2D sidebar sliders the host forwards in gpsParams.
    if (gpsParams) {
      const tw = +gpsParams.trackWeight;
      if (isFinite(tw) && tw > 0) this.trackWidth = tw;
      const pl = +gpsParams.peakLatency;
      this.peakLatency = isFinite(pl) && pl > 0 ? pl : 0;
    }

    this.currentAnalyzer = analyzer;

    const drawPoints = Array.isArray(providedDrawPoints)
      ? providedDrawPoints
      : [];
    this.currentDrawPoints = drawPoints;

    if (drawPoints.length < 2) {
      this._notifyWarn(
        'Track contains insufficient GPS coordinates to render in 3D.',
      );
      return;
    }

    // Filter peaks by quality threshold
    this.currentPeaks = (analyzer.peaks || []).filter((pk) => !pk.excluded);

    // Clear every layer from any previous track (peaks/RF leaked before) and
    // rebuild from the now-cached track — see _rebuildLayers().
    this._rebuildLayers();

    if (!isPreview) {
      this.flyToTrack();
    }
  }

  /**
   * Force one repaint when running in requestRenderMode — raw scene.primitives
   * changes (the arousal wall, RF field, buildings) don't schedule one on their
   * own the way the Entity API does. No-op in continuous-render mode.
   */
  _requestRender() {
    if (this.requestRenderMode && this.viewer?.scene) {
      this.viewer.scene.requestRender();
    }
  }

  /**
   * A Cesium.Color[] mirror of MapColors.getColorLut(metric, min, max) — the
   * same 30 bucket-midpoint colours the 2D map uses, parsed to Cesium.Color
   * once and cached by (metric, range) so a wall rebuild parses ≤ 30 CSS
   * strings instead of one per segment. See _render3DWallAndPath.
   */
  _getCesiumColorLut(metric, minVal, maxVal) {
    const key = `${metric}|${minVal.toFixed(4)}|${maxVal.toFixed(4)}`;
    if (this._cesiumColorLutKey === key && this._cesiumColorLut)
      return this._cesiumColorLut;
    const hexLut = MapColors.getColorLut(metric, minVal, maxVal);
    this._cesiumColorLut = hexLut.map((hex) =>
      Cesium.Color.fromCssColorString(hex).withAlpha(0.85),
    );
    this._cesiumColorLutKey = key;
    return this._cesiumColorLut;
  }

  /**
   * Thin `drawPoints` for the wall build only (`currentDrawPoints` stays
   * full-resolution and still drives hover / camera / scrub). Always keeps the
   * endpoints, both points either side of a >15 s time gap, and RF-peak points;
   * between those it keeps a point when the path turns (~>4°), the colour bucket
   * changes, or the extruded height moves >1.5 m — and forces a keep at least
   * every `maxStride` points and every 10 s so a long straight flat run can't
   * blow the budget or fake a time gap. Returns a subset of the SAME point
   * objects. No-op below the budget.
   */
  _decimateForWall(drawPoints, colorSeries, heightAt, bucketOf, minVal) {
    const n = drawPoints.length;
    const budget = this.wallMaxSegments || WALL_MAX_SEGMENTS;
    if (!(n > budget + 1)) return drawPoints;

    const maxStride = Math.max(2, Math.ceil((n - 1) / budget));
    const out = [drawPoints[0]];
    let kept = 0;
    let keptBucket = bucketOf(colorSeries[drawPoints[0].origIdx] ?? minVal);
    let keptH = heightAt(drawPoints[0].origIdx);

    for (let i = 1; i < n - 1; i++) {
      const p = drawPoints[i];
      const stride = i - kept;
      const gapBefore = p.time - drawPoints[i - 1].time > 15.0;
      const gapAfter = drawPoints[i + 1].time - p.time > 15.0;

      let keep =
        p.isRfPeak ||
        gapBefore ||
        gapAfter ||
        stride >= maxStride ||
        p.time - drawPoints[kept].time > 10.0;

      if (!keep && stride >= 2) {
        const b = bucketOf(colorSeries[p.origIdx] ?? minVal);
        const h = heightAt(p.origIdx);
        if (b !== keptBucket || Math.abs(h - keptH) > 1.5) {
          keep = true;
        } else {
          const a = drawPoints[kept];
          const c = drawPoints[i + 1];
          const x1 = p.lon - a.lon,
            y1 = p.lat - a.lat;
          const x2 = c.lon - p.lon,
            y2 = c.lat - p.lat;
          if (Math.abs(Math.atan2(x1 * y2 - y1 * x2, x1 * x2 + y1 * y2)) > 0.07)
            keep = true; // ~4°
        }
      }

      if (keep) {
        out.push(p);
        kept = i;
        keptBucket = bucketOf(colorSeries[p.origIdx] ?? minVal);
        keptH = heightAt(p.origIdx);
      }
    }
    out.push(drawPoints[n - 1]);
    return out;
  }

  /**
   * Build the extruded arousal wall and the clamped ground polyline.
   *
   * The wall is one batched GPU Primitive. Cost is dominated by Cesium's
   * geometry pipeline (WallGeometry.createGeometry + combineGeometry), see
   * tests/manual/_bench_globe3d_perf.js, so three things keep it small:
   *   1. the display points are thinned to WALL_MAX_SEGMENTS, keeping every
   *      point that changes the wall's shape / height / colour (a walk has
   *      >10k points; at the zoom that frames the whole track that's tens of
   *      points per pixel);
   *   2. consecutive segments in the same 30-bucket colour band merge into one
   *      multi-vertex WallGeometry (a smooth track → tens of instances);
   *   3. the geometry is flat/unlit (POSITION-only vertex format — no normals),
   *      matching the appearance, so createGeometry skips normal computation.
   * Colour comes from a bounded Cesium.Color LUT; positions are one
   * fromDegreesArray call.
   */
  _render3DWallAndPath(analyzer, drawPoints) {
    if (drawPoints.length < 2) return;

    const metric = this.activeColoringMetric;
    // Colour follows the (possibly host-driven) metric; height follows a fixed
    // arousal-magnitude series so a non-magnitude colour metric still extrudes.
    const discrete =
      metric === 'roadClass' ||
      metric === 'inPark' ||
      metric === 'responseDynamics';
    const rawSeries = this._getMetricSeries(analyzer, metric);
    const heightMetric = HEIGHT_CAPABLE_METRICS.has(metric)
      ? metric
      : this.heightMetric;
    const heightSeries =
      heightMetric === metric
        ? rawSeries
        : this._getMetricSeries(analyzer, heightMetric);

    const heightAt = (idx) =>
      this.baseHeight +
      Math.max(0, heightSeries[idx] ?? 0) * this.extrusionScale;

    // The series the wall colour buckets read, the per-bucket colour lookup, and
    // the bucketing function. For categorical/binary OSM metrics (`roadClass`,
    // `inPark`) `colorSeries` is a dense array of category indices (missing → 0,
    // the grey "no data" bucket) so the merge/decimation machinery below works
    // unchanged; `bucketOf` is the identity and `colorOf` resolves the category
    // colour. For continuous metrics these are the raw numeric series, the 30-
    // bucket LUT, and the standard min/max bucketing — normalised against the
    // host's 2D legend range when the host supplies one.
    let colorSeries;
    let colorOf;
    let bucketOf;
    let minVal = 0;

    if (discrete) {
      if (metric === 'responseDynamics') {
        const RD = ResponseDynamics;
        const speedColors = RD
          ? RD.SPEED_COLORS
          : {
              'Very Slow': '#8b5cf6',
              Slow: '#3b82f6',
              Standard: '#10b981',
              Fast: '#f97316',
              'Very Fast': '#ef4444',
            };
        const colors = [
          Cesium.Color.TRANSPARENT,
          Cesium.Color.fromCssColorString(speedColors['Very Slow']).withAlpha(
            0.85,
          ),
          Cesium.Color.fromCssColorString(speedColors.Slow).withAlpha(0.85),
          Cesium.Color.fromCssColorString(speedColors.Standard).withAlpha(0.85),
          Cesium.Color.fromCssColorString(speedColors.Fast).withAlpha(0.85),
          Cesium.Color.fromCssColorString(speedColors['Very Fast']).withAlpha(
            0.85,
          ),
        ];
        const indexOf = (v) =>
          RD
            ? RD.getBucketIndex(v)
            : v == null || !isFinite(v) || v <= 0
              ? 0
              : 3;
        colorSeries = new Array(rawSeries.length);
        for (let i = 0; i < rawSeries.length; i++)
          colorSeries[i] = indexOf(rawSeries[i]);
        colorOf = (k) => colors[k] || colors[0];
        bucketOf = (v) => (v == null ? 0 : v);
      } else {
        const NO_DATA = 0;
        const catIndex = new Map();
        const colors = [
          Cesium.Color.fromCssColorString('#666666').withAlpha(0.85),
        ];
        const indexOf = (v) => {
          if (v === null || v === undefined || v === '') return NO_DATA;
          let i = catIndex.get(v);
          if (i === undefined) {
            i = catIndex.size + 1; // 0 is reserved for "no data"
            catIndex.set(v, i);
            const cssColor = MapColors.getColorForMetric(metric, v, 0, 1);
            colors[i] =
              Cesium.Color.fromCssColorString(cssColor).withAlpha(0.85);
          }
          return i;
        };
        colorSeries = new Array(rawSeries.length);
        for (let i = 0; i < rawSeries.length; i++)
          colorSeries[i] = indexOf(rawSeries[i]);
        colorOf = (k) => colors[k] || colors[0];
        bucketOf = (v) => (v == null ? NO_DATA : v);
      }
    } else {
      // Colour normalisation range: the host's legend range when it owns it
      // (2D view is the source of truth), otherwise computed over drawn points.
      minVal = Infinity;
      let maxVal = -Infinity;

      if (this.externalColorRange) {
        minVal = this.externalColorRange.min;
        maxVal = this.externalColorRange.max;
      } else {
        for (let i = 0; i < drawPoints.length; i++) {
          const idx = drawPoints[i].origIdx;
          const v = rawSeries[idx];
          if (v != null && !isNaN(v)) {
            if (v < minVal) minVal = v;
            if (v > maxVal) maxVal = v;
          }
        }
      }

      if (!isFinite(minVal) || !isFinite(maxVal) || minVal === maxVal) {
        minVal = 0;
        maxVal = 1;
      }

      const NB = 30; // colour-bucket count — matches MapColors.getColorLut()
      const range = maxVal - minVal;
      const colorLut = this._getCesiumColorLut(metric, minVal, maxVal);
      bucketOf = (v) =>
        range > 1e-9
          ? Math.max(
              0,
              Math.min(NB - 1, Math.floor(((v - minVal) / range) * NB)),
            )
          : NB >> 1;
      colorOf = (k) => colorLut[k] || colorLut[0];
      colorSeries = rawSeries;
    }

    // Thin the path for the wall only (currentDrawPoints stays full-resolution
    // for hover / camera / scrub). Keeps corners, colour-bucket changes and
    // >1.5 m height steps; drops straight, flat, same-colour runs.
    const wallPts = this._decimateForWall(
      drawPoints,
      colorSeries,
      heightAt,
      bucketOf,
      minVal,
    );

    // One fromDegreesArray for the whole thinned path — positions[i] ↔ wallPts[i].
    const flat = new Array(wallPts.length * 2);
    for (let i = 0; i < wallPts.length; i++) {
      flat[i * 2] = wallPts[i].lon;
      flat[i * 2 + 1] = wallPts[i].lat;
    }
    const positions = Cesium.Cartesian3.fromDegreesArray(flat);

    const wallInstances = [];
    const groundPositions = [];

    // Current merge run: same colour bucket, contiguous in time.
    let runPos = null; // Cartesian3[]
    let runMax = null; // number[] (max wall heights, per vertex)
    let runBucket = -1;
    let instanceSeq = 0;

    const flushRun = () => {
      if (!runPos || runPos.length < 2) {
        runPos = runMax = null;
        return;
      }
      if (metric === 'responseDynamics' && runBucket === 0) {
        runPos = runMax = null;
        return;
      }
      try {
        wallInstances.push(
          new Cesium.GeometryInstance({
            geometry: new Cesium.WallGeometry({
              positions: runPos,
              minimumHeights: new Array(runPos.length).fill(0.0),
              maximumHeights: runMax,
              // POSITION-only: the appearance is flat/unlit, so normals would be
              // computed and uploaded for nothing.
              vertexFormat:
                Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT,
            }),
            attributes: {
              color: Cesium.ColorGeometryInstanceAttribute.fromColor(
                colorOf(runBucket),
              ),
            },
            id: `biomap-wall-${instanceSeq++}`,
          }),
        );
      } catch (_err) {
        // Skip a degenerate run (coincident points) cleanly.
      }
      runPos = runMax = null;
    };

    for (let i = 0; i < wallPts.length - 1; i++) {
      const p1 = wallPts[i];
      const p2 = wallPts[i + 1];

      // Time gap (paused / lost fix > 15 s) breaks both the wall run and the
      // ground line.
      if (Math.abs(p2.time - p1.time) > 15.0) {
        flushRun();
        continue;
      }

      const v1 = colorSeries[p1.origIdx] ?? minVal;
      const v2 = colorSeries[p2.origIdx] ?? minVal;
      // Discrete metrics carry an integer category index — bucket by the
      // leading point's category (each wall segment already sits within one
      // category because _decimateForWall keeps every category change).
      const bucket = discrete ? v1 : bucketOf((v1 + v2) / 2);
      const h1 = heightAt(p1.origIdx);
      const h2 = heightAt(p2.origIdx);

      groundPositions.push(positions[i]);
      if (i === wallPts.length - 2) groundPositions.push(positions[i + 1]);

      if (runPos && bucket === runBucket) {
        // extend the current run — positions[i] is already its last vertex
        runPos.push(positions[i + 1]);
        runMax.push(h2);
      } else {
        flushRun();
        runPos = [positions[i], positions[i + 1]];
        runMax = [h1, h2];
        runBucket = bucket;
      }
    }
    flushRun();

    if (wallInstances.length > 0) {
      this.wallPrimitive = new Cesium.Primitive({
        geometryInstances: wallInstances,
        // flat: match the old unlit `wall.material = color` look (scene lighting is off)
        appearance: new Cesium.PerInstanceColorAppearance({
          flat: true,
          translucent: true,
          closed: false,
        }),
        // Always async: geometry is compiled off the main thread so a slider drag
        // doesn't stall the paint (matches buildings.js).
        asynchronous: true,
      });
      this.viewer.scene.primitives.add(this.wallPrimitive);
    }

    // Ground outline track
    if (this.showGroundPath && groundPositions.length >= 2) {
      const groundEntity = this.viewer.entities.add({
        name: 'Biomap Ground Path',
        polyline: {
          positions: groundPositions,
          // Track Width slider (gpsTrackWeight) — the 3D counterpart of the 2D
          // L.polyline weight in map.js:_renderPathSegments.
          width: this.trackWidth || 3.0,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.25,
            color: Cesium.Color.WHITE.withAlpha(0.7),
          }),
          clampToGround: true,
        },
      });
      this.trackEntities.push(groundEntity);
    }
  }

  /**
   * Terrain elevation (m) at lat/lon, or 0 when terrain isn't loaded / the tile
   * isn't ready. Mirrors setScrubPosition()'s sampling. @private
   */
  _groundHeightAt(lat, lon) {
    try {
      const globe = this.viewer?.scene?.globe;
      if (globe && typeof globe.getHeight === 'function') {
        const h = globe.getHeight(Cesium.Cartographic.fromDegrees(lon, lat));
        if (typeof h === 'number' && isFinite(h)) return h;
      }
    } catch (_e) {
      /* terrain not ready */
    }
    return 0;
  }

  /**
   * Retrieve the colouring-metric series from the analyzer as plain floats.
   * Derived metrics (SERIES_FIELD) come from per-sample analyzer arrays; anything
   * else falls back to the raw GSR series.
   *
   * Memoised per render: `_renderPeakSpires` / `_renderHotspots` ask for the
   * height series once per peak, and each miss was a full `.map()` over the
   * whole ~35k-sample track — ~320 ms of a rebuild on a 900-peak walk. The
   * cache is keyed by field and by the source array's identity, and is dropped
   * outright at the top of `renderData` / `_refreshTrack` because `analyze()`
   * refills the analyzer's series buffers in place (same array ref, new values).
   */
  _getMetricSeries(analyzer, metric) {
    const field = SERIES_FIELD[metric];
    const useDerived = !!(
      field &&
      analyzer[field] &&
      analyzer[field].length > 0
    );
    const src = useDerived ? analyzer[field] : analyzer.raw || null;
    // Raw-field metrics each key their own cache entry: two colour metrics
    // (e.g. greenPct vs distWater) read different raw columns, so a single
    // '__raw__' key would collide within one render.
    const rawField = useDerived ? null : rawMetricField(metric);
    const key = useDerived ? field : `raw:${rawField || 'gsr'}`;

    const cache =
      this._metricSeriesCache || (this._metricSeriesCache = new Map());
    const hit = cache.get(key);
    if (hit && hit.src === src) return hit.out;

    let out;
    if (useDerived) {
      out = src.map(seriesValue);
    } else if (src && src.length > 0) {
      if (rawField === 'gsr') {
        out = src.map((d) =>
          d.gsr !== undefined ? d.gsr : d.val !== undefined ? d.val : 0,
        );
      } else if (rawField) {
        // Enrichment columns are NaN/absent until the track is enriched — map
        // those to null so the wall renderer's `?? minVal` fallback and the
        // min/max scan can both treat "no data" consistently.
        out = src.map((d) => {
          const v = d[rawField];
          return v === undefined ||
            v === null ||
            (typeof v === 'number' && isNaN(v))
            ? null
            : v;
        });
      } else {
        out = src.map((d) =>
          d.gsr !== undefined ? d.gsr : d.val !== undefined ? d.val : 0,
        );
      }
    } else {
      out = [];
    }
    cache.set(key, { src, out });
    return out;
  }

  /** Drop the per-render metric-series memo (see _getMetricSeries). @private */
  _invalidateMetricSeriesCache() {
    if (this._metricSeriesCache) this._metricSeriesCache.clear();
  }

  /**
   * Run `fn` (a clear + rebuild of the entity layers) inside one
   * EntityCollection event batch, so Cesium's Visualizers process the whole
   * add/remove churn in a single diff instead of once per entity. `fn` only
   * ever `entities.add`s / `entities.remove`s and pushes to our own arrays, so
   * deferring the collection events is safe. suspendEvents is refcounted —
   * the finally guarantees the pairing even if a rebuild throws.
   * @private
   */
  _withEntityBatch(fn) {
    const ents = this.viewer?.entities;
    const batch = ents && typeof ents.suspendEvents === 'function';
    if (batch) ents.suspendEvents();
    try {
      fn();
    } finally {
      if (batch) ents.resumeEvents();
    }
  }

  /**
   * Clear and rebuild every 3D layer (wall + path, peak spires, hotspots,
   * cluster ground-blobs, RF volume) from the cached track, all inside one
   * EntityCollection batch so the Cesium Visualizers diff the add/remove churn
   * once rather than per entity.
   *
   * Shared by renderData() (a fresh track — currentAnalyzer/currentDrawPoints/
   * currentPeaks are assigned just before the call) and _refreshTrack() (a
   * slider-driven refresh from the same cached track). Both had grown a
   * byte-identical copy of this sequence, so a fix to one — the batch, the
   * clear order, _syncClusterBlobs — had to be mirrored into the other by hand.
   * @private
   */
  _rebuildLayers() {
    this._invalidateMetricSeriesCache();
    this._withEntityBatch(() => {
      this.clearTrackEntities();
      this.clearPeakEntities();
      this.clearHotspotEntities();
      this.clearRfEntities();
      this._render3DWallAndPath(this.currentAnalyzer, this.currentDrawPoints);
      if (this.showPeaks || this.showLabels) {
        this._renderPeakSpires(this.currentAnalyzer, this.currentPeaks);
      }
      if (this.showHotspots) this._renderHotspots(this.currentAnalyzer);
      // Ground blobs only when the hulls / Clusters toggle actually changed — a
      // GSR/GPS/extrusion/metric slider push never touches them, and
      // clamp-to-ground primitives blink on remove+add (see _syncClusterBlobs).
      this._syncClusterBlobs();
      // RF volume: its raw Primitive is lost on context restore and stale after
      // a slider-driven metric/extrusion change, so re-upload it here.
      if (this.showRfVolumetric)
        this.render3DRfExpanse(this.currentAnalyzer, this.currentDrawPoints);

      // OSM buildings: clearAll() (a track being removed, or a context loss)
      // drops the extruded primitive but leaves show3DBuildings set. Re-assert
      // it here, but ONLY when it is genuinely gone — present buildings are
      // left alone so a slider drag doesn't blink them.
      if (
        this.show3DBuildings &&
        this.cachedOsmJson &&
        !this.buildingPrimitive &&
        !this.buildingsTileset?.show &&
        !this._buildingsFetching
      ) {
        this.renderOsm3DBuildings(
          this.cachedOsmJson,
          this.buildingStyle || 'monochrome',
        );
      }
    });
    this._raiseMarkerCollections();
    this._requestRender();
  }

  /**
   * Keep the batched peak/hotspot marker collections at the top of the scene's
   * primitive list. They are added once (lazily, on the first render) and then
   * persist, but the arousal wall primitive is removed and re-added on every
   * rebuild, so after the first rebuild the wall sits ABOVE them in primitive
   * order. The wall is translucent (85% alpha), and for near-equal depths that
   * primitive order is what decides overdraw — leaving the markers underneath
   * lets the wall wash over them from some camera angles. @private
   */
  _raiseMarkerCollections() {
    const prims = this.viewer?.scene?.primitives;
    if (!prims || typeof prims.raiseToTop !== 'function') return;
    if (this._peakPoints) prims.raiseToTop(this._peakPoints);
    if (this._peakLabels) prims.raiseToTop(this._peakLabels);
    if (this._hotspotLabels) prims.raiseToTop(this._hotspotLabels);
  }

  /** Re-draw the wall + the peak/hotspot/cluster/RF layers from the cached track. */
  _refreshTrack() {
    // May run a frame late now (setExtrusionScale coalesces via rAF), so guard
    // the viewer explicitly in case a destroy()/context-loss landed in between.
    if (
      !this.viewer ||
      !this.currentAnalyzer ||
      this.currentDrawPoints.length < 2
    )
      return;
    this._rebuildLayers();
  }

  /** Set active colouring metric and refresh. */
  setColoringMetric(metric) {
    this.activeColoringMetric = metric;
    this._refreshTrack();
  }

  /**
   * Adjust extruded wall-height scale and refresh. The scale changes on every
   * `input` event of a slider drag — faster than a wall rebuild — so the
   * rebuild is coalesced to at most one per animation frame with the latest
   * value. The number in the UI still updates live (the host owns that label).
   */
  setExtrusionScale(scale) {
    this.extrusionScale = scale;
    if (this._extrusionRaf) return;
    const raf =
      typeof window !== 'undefined' && window.requestAnimationFrame
        ? window.requestAnimationFrame.bind(window)
        : (fn) => setTimeout(fn, 16);
    this._extrusionRaf = raf(() => {
      this._extrusionRaf = 0;
      this._refreshTrack();
    });
  }

  // GSRGlobeManager is completed by prototype-augment files loaded immediately
  // after this one (see index.html / boot_app.js SCRIPT_ORDER):
  //   globe3d_osm.js         — 3D OSM building extrusion (orchestration; geometry in globe3d/buildings.js)
  //   globe3d_rf.js          — volumetric RF expanse control (orchestration; geometry in globe3d/rf_expanse.js)
  //   globe3d_peaks.js       — peak spires, hotspots, cluster ground blobs
  //   globe3d_toggles.js     — layer visibility toggles + entity clearing
  //   globe3d_navigation.js  — fly-to/focus + turntable orbit
  //   globe3d_tour.js        — automated sequential track tour
  // 3D track export (CZML / KML) lives in src/map/globe3d/exporters.js and is
  // driven from the main Export Options panel — it needs no live viewer. The 3D
  // PNG snapshot was dropped: the app's Save Canvas / Bio Map PNG covers it.
}
