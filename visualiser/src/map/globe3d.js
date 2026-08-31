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

/**
 * Resolve the CARTO basemap key the same way map.js / live.html do:
 * BIOMAP_CONFIG.cartoApiKey, then a localStorage fallback (guarded), then
 * appended as ?key=<encoded>. Kept identical so all three stay in step —
 * see tests/test_html_wiring.js.
 */
function cartoTileUrl(styleSlug) {
  let cartoKey = (typeof window !== 'undefined' && window.BIOMAP_CONFIG && window.BIOMAP_CONFIG.cartoApiKey) || '';
  if (!cartoKey) {
    try { cartoKey = localStorage.getItem('bioMappingCartoApiKey') || ''; } catch (e) { /* no-op */ }
  }
  return `https://{s}.basemaps.cartocdn.com/${styleSlug}/{z}/{x}/{y}.png` +
    (cartoKey ? '?key=' + encodeURIComponent(cartoKey) : '');
}

/** basemap id -> factory producing a fresh Cesium imagery provider (no API key required) */
const BASEMAP_PROVIDERS = {
  satellite: () => new Cesium.UrlTemplateImageryProvider({
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    maximumLevel: 19,
    credit: 'Esri, Maxar, Earthstar Geographics'
  }),
  sentinel: () => new Cesium.UrlTemplateImageryProvider({
    url: 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg',
    maximumLevel: 16,
    credit: 'Sentinel-2 cloudless by EOX IT Services GmbH (Contains modified Copernicus Sentinel data)'
  }),
  nasa: () => new Cesium.UrlTemplateImageryProvider({
    url: 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg',
    maximumLevel: 8,
    credit: 'NASA GIBS / Landsat / Blue Marble'
  }),
  osm: () => new Cesium.OpenStreetMapImageryProvider({ url: 'https://tile.openstreetmap.org/' }),
  dark: () => new Cesium.UrlTemplateImageryProvider({
    url: cartoTileUrl('dark_all'), subdomains: ['a', 'b', 'c', 'd'], maximumLevel: 19
  }),
  positron: () => new Cesium.UrlTemplateImageryProvider({
    url: cartoTileUrl('light_all'), subdomains: ['a', 'b', 'c', 'd'], maximumLevel: 19
  })
};

/**
 * Coloring metric -> analyzer per-sample series field. Mirrors DERIVED_METRIC_SERIES
 * in map.js; anything not listed falls back to the raw GSR series.
 */
const SERIES_FIELD = {
  phasic: 'phasic',
  tonic: 'tonic',
  arousalIndex: 'arousalIndex',
  peakDensity: 'peakDensity',
  phasicAUC: 'phasicAUC',
  em_fog: 'em_fog',
  emFog: 'em_fog'
};

/**
 * Metrics whose values are an arousal magnitude and so make sense as a wall
 * height. Anything outside this set (raw GSR aside) colours the wall but can't
 * drive its extrusion — the embedded host keeps height on a fixed arousal
 * series (heightMetric) while colour follows whatever the 2D view is showing.
 */
const HEIGHT_CAPABLE_METRICS = new Set(['gsr', 'phasic', 'tonic', 'arousalIndex', 'peakDensity', 'phasicAUC']);

/** Unwrap one analyzer series sample ({time,val} | number) to a plain float. */
const seriesValue = (d) =>
  (d && typeof d === 'object' && 'val' in d) ? d.val : (typeof d === 'number' ? d : 0);

// The arousal wall is thinned to at most this many segments before it is built
// (see _decimateForWall): a walk can carry >10k display points and at the zoom
// that frames the whole track they are tens of points per pixel. Override per
// instance with options.wallMaxSegments (Infinity disables thinning).
const WALL_MAX_SEGMENTS = 2500;

// ─────────────────────────────────────────────────────────────────────────────
// GSRGlobeManager
// ─────────────────────────────────────────────────────────────────────────────

class GSRGlobeManager {
  /**
   * @param {string} containerId  DOM id of the element to mount the Cesium viewer in.
   * @param {object} [options]
   * @param {string}  [options.metric='phasic']       initial coloring metric
   * @param {number}  [options.extrusionScale=8.0]    initial wall-height scale
   * @param {boolean} [options.keyboardFlight=true]   bind window WASD/arrow flight keys
   * @param {boolean} [options.doubleClickFly=true]   double-click canvas to fly to point
   * @param {boolean} [options.requestRenderMode=false]  render only on scene change /
   *   explicit requestRender() instead of every frame — big idle-cost win for an
   *   embedded panel.
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
    this.extrusionScale = options.extrusionScale || 8.0;    // Meters of height per metric unit
    this.baseHeight = 2.0;                                  // Minimum base wall height in meters
    this.wallMaxSegments = options.wallMaxSegments || WALL_MAX_SEGMENTS; // wall thinning budget
    this.showPeaks = true;
    this.minPeakQuality = 0.0;
    this.showGroundPath = true;
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

    // Colour LUT cache (Cesium.Color[] mirror of MapColors.getColorLut) + last
    // basemap id, for _render3DWallAndPath and context-restore.
    this._cesiumColorLut = null;
    this._cesiumColorLutKey = null;
    this._currentBasemap = null;

    // 3D Volumetric RF Expanse settings
    this.showRfVolumetric = false;
    this.rfMode = 'triband'; // 'triband' | '815' | '868' | '915' | 'fog'
    this.rfHeight = 25.0;    // Volumetric ceiling in meters
    this.rfOpacity = 0.45;
    this.rfPrimitive = null;

    // Orbit camera animation
    this._isOrbiting = false;
    this._orbitRemoveCallback = null;

    // Follow-cam: true while the camera is locked onto the scrub cursor (a
    // Cesium lookAt transform is active and must be released — see
    // followScrub() / releaseFollowScrub()).
    this._followingScrub = false;

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
    Cesium.Ion.defaultAccessToken = (window.BIOMAP_CONFIG && window.BIOMAP_CONFIG.cesiumIonToken) || '';

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
        maximumRenderTimeChange: this.requestRenderMode ? Infinity : 0.0
      });
    } catch (err) {
      // WebGL context creation can fail outright (no GPU, blocklisted driver,
      // too many live contexts). Leave this.viewer null — every method guards
      // on it and the host (globe3d_view.activate) shows a degrade message.
      this.viewer = null;
      this._notifyError(err);
      return;
    }

    // Set initial ArcGIS satellite basemap immediately
    this.setBasemap('satellite');

    const scene = this.viewer.scene;
    const globe = scene.globe;

    // Fast, lightweight rendering settings
    globe.enableLighting = false;
    globe.depthTestAgainstTerrain = false;
    scene.fog.enabled = true;
    scene.fog.density = 0.0001;

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
    // Cap the tile-cache growth so a long session doesn't balloon GPU memory.
    globe.tileCacheSize = 100;

    // Optional Cesium Ion Terrain if token provided
    if (Cesium.Ion.defaultAccessToken && typeof Cesium.Terrain !== 'undefined') {
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

    // Mouse button mappings (Google Earth standard):
    // 1. Left Drag -> Pan / Rotate globe
    controller.rotateEventTypes = [
      Cesium.CameraEventType.LEFT_DRAG
    ];

    // 2. Right Drag or Wheel -> Smooth Zoom
    controller.zoomEventTypes = [
      Cesium.CameraEventType.RIGHT_DRAG,
      Cesium.CameraEventType.WHEEL,
      Cesium.CameraEventType.PINCH
    ];

    // 3. Middle Click Drag OR Shift+Left Drag OR Ctrl+Left Drag -> 3D Tilt & Orbit
    controller.tiltEventTypes = [
      Cesium.CameraEventType.MIDDLE_DRAG,
      Cesium.CameraEventType.PINCH,
      {
        eventType: Cesium.CameraEventType.LEFT_DRAG,
        modifier: Cesium.KeyboardEventModifier.SHIFT
      },
      {
        eventType: Cesium.CameraEventType.LEFT_DRAG,
        modifier: Cesium.KeyboardEventModifier.CTRL
      },
      {
        eventType: Cesium.CameraEventType.RIGHT_DRAG,
        modifier: Cesium.KeyboardEventModifier.CTRL
      }
    ];

    // 4. Alt + Left Drag -> Free look
    controller.lookEventTypes = [
      {
        eventType: Cesium.CameraEventType.LEFT_DRAG,
        modifier: Cesium.KeyboardEventModifier.ALT
      }
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
      const idx = picked && picked.id && picked.id._biomapPeakIndex;
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
          const curHeight = this.viewer.camera.positionCartographic.height;
          const targetHeight = Math.max(150.0, curHeight * 0.45);
          this.viewer.camera.flyTo({
            destination: Cesium.Cartesian3.fromRadians(
              cartographic.longitude,
              cartographic.latitude,
              targetHeight
            ),
            duration: 1.2
          });
        }
      }, Cesium.ScreenSpaceEventType.LEFT_DOUBLE_CLICK);
    }

    // 5c. MOUSE_MOVE over the 3D track -> report the nearest drawPoint's series
    // index to the host, the 3D counterpart of hovering the 2D map path. The
    // host walks the graph scrubber to that moment (see globe3d_view.js
    // _onScrubHover). Cheap: an ellipsoid pick plus a linear scan of the drawn
    // points, gated on a camera-height-scaled radius so a hover only "sticks"
    // when the pointer is genuinely near the line.
    // The pick is coalesced to one run per animation frame — several MOUSE_MOVEs
    // can arrive between paints and only the last position matters.
    this._pendingHoverPos = null;
    this._hoverRaf = 0;
    const raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
      ? window.requestAnimationFrame.bind(window)
      : (fn) => setTimeout(fn, 16);
    const runHoverPick = () => {
      this._hoverRaf = 0;
      const pos = this._pendingHoverPos;
      this._pendingHoverPos = null;
      if (!pos || !this._scrubHoverCb) return;
      const hit = this._pickTrackPoint(pos);
      this._scrubHoverCb(hit ? hit.origIdx : null, hit ? { lat: hit.lat, lon: hit.lon } : undefined);
    };
    this._screenSpaceHandler.setInputAction((movement) => {
      if (!this._scrubHoverCb) return;
      this._pendingHoverPos = { x: movement.endPosition.x, y: movement.endPosition.y };
      if (!this._hoverRaf) this._hoverRaf = raf(runHoverPick);
    }, Cesium.ScreenSpaceEventType.MOUSE_MOVE);

    // The pointer leaving the canvas entirely fires no MOUSE_MOVE — clear the
    // hover explicitly so the graph scrubber doesn't stick.
    this._scrubHoverLeaveHandler = () => { if (this._scrubHoverCb) this._scrubHoverCb(null); };
    scene.canvas.addEventListener('mouseleave', this._scrubHoverLeaveHandler);

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
        if (lastCam && Cesium.Cartesian3.equalsEpsilon(p, lastCam, 1e-9)) return;
        lastCam = Cesium.Cartesian3.clone(p, lastCam);
        this._wakeRenderLoop();
      });
    }

    // 8. WebGL context loss/restore. A long-lived embedded viewer can lose its
    // GL context (GPU reset, tab backgrounded on some drivers, too many live
    // contexts). Without this the canvas just freezes black. preventDefault on
    // 'lost' lets the browser hand the context back; on 'restored' rebuild the
    // scene contents Cesium can't restore itself (our raw primitives).
    this._onContextLost = (e) => { if (e && e.preventDefault) e.preventDefault(); };
    this._onContextRestored = () => {
      if (!this.viewer) return;
      try {
        this.setBasemap(this._currentBasemap || 'satellite');
        this._refreshTrack();
        this._requestRender();
      } catch (err) { this._notifyError(err); }
    };
    scene.canvas.addEventListener('webglcontextlost', this._onContextLost, false);
    scene.canvas.addEventListener('webglcontextrestored', this._onContextRestored, false);
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
      if (this.viewer && !this._isOrbiting) this.viewer.scene.requestRenderMode = true;
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
      yawRight: false
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
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
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
    this._flightTickRemover = this.viewer.clock.onTick.addEventListener(flightTick);
  }

  /**
   * Tear down the viewer and every listener/primitive this manager created.
   * Safe to call more than once. Required by any host that mounts and unmounts
   * the 3D view repeatedly (e.g. an index.html view tab).
   */
  destroy() {
    this.stopOrbit();
    this.releaseFollowScrub();
    this.clearAll();

    const canvas = this.viewer && this.viewer.scene && this.viewer.scene.canvas;
    if (this._scrubHoverLeaveHandler && canvas) {
      canvas.removeEventListener('mouseleave', this._scrubHoverLeaveHandler);
    }
    this._scrubHoverLeaveHandler = null;
    this._scrubHoverCb = null;

    if (canvas) {
      if (this._onContextLost) canvas.removeEventListener('webglcontextlost', this._onContextLost, false);
      if (this._onContextRestored) canvas.removeEventListener('webglcontextrestored', this._onContextRestored, false);
    }
    this._onContextLost = null;
    this._onContextRestored = null;
    if (this._hoverRaf && typeof window !== 'undefined' && window.cancelAnimationFrame) {
      window.cancelAnimationFrame(this._hoverRaf);
    }
    this._hoverRaf = 0;
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
    if (this._wakeHandlers && this.viewer && this.viewer.scene && this.viewer.scene.canvas) {
      const canvas = this.viewer.scene.canvas;
      this._wakeHandlers.forEach(({ type, h }) => canvas.removeEventListener(type, h));
    }
    this._wakeHandlers = null;
    if (this._screenSpaceHandler && !this._screenSpaceHandler.isDestroyed()) {
      this._screenSpaceHandler.destroy();
    }
    this._screenSpaceHandler = null;
    this._peakClickCb = null;

    if (this.viewer && !this.viewer.isDestroyed()) {
      this.viewer.destroy();
    }
    this.viewer = null;
    this.currentAnalyzer = null;
    this.currentDrawPoints = [];
    this.currentPeaks = [];
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
        roll: 0.0
      },
      duration: 0.8
    });
  }

  /**
   * Switch perspective preset ('3d' | 'top' | 'ground')
   */
  setViewPerspective(mode) {
    if (!this.viewer) return;
    this._wakeRenderLoop();
    const camera = this.viewer.camera;
    let pitchDeg = -45.0;
    if (mode === 'top') pitchDeg = -89.9; // top-down 2D
    if (mode === 'ground') pitchDeg = -15.0; // eye-level 3D
    if (mode === '3d') pitchDeg = -45.0; // isometric 3D

    if (this.currentDrawPoints && this.currentDrawPoints.length > 0) {
      const positions = this.currentDrawPoints.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat));
      const boundingSphere = Cesium.BoundingSphere.fromPoints(positions);
      const pitch = Cesium.Math.toRadians(pitchDeg);
      const heading = camera.heading;
      const range = Math.max(boundingSphere.radius * (mode === 'ground' ? 1.4 : 2.2), 350.0);

      this.viewer.camera.flyToBoundingSphere(boundingSphere, {
        offset: new Cesium.HeadingPitchRange(heading, pitch, range),
        duration: 0.8
      });
    } else {
      camera.flyTo({
        destination: camera.position,
        orientation: {
          heading: camera.heading,
          pitch: Cesium.Math.toRadians(pitchDeg),
          roll: 0.0
        },
        duration: 0.8
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
    } catch (err) {
      this._notifyWarn('Could not switch basemap — keeping the current one.');
      return;
    }
    layers.removeAll();
    if (provider) {
      layers.addImageryProvider(provider);
      this._currentBasemap = type;
    }
    this._requestRender();
  }

  /**
   * Toggle 3D Buildings: Uses direct OpenStreetMap Overpass vector extrusion (token-free)
   * or falls back to Cesium ion 3D Tiles if configured.
   * @param {boolean} show
   * @param {'monochrome'|'glass'|'dark'|'realistic'} [style='monochrome']
   * @param {Function} [onStatus]
   */
  async toggle3DBuildings(show, style = 'monochrome', onStatus) {
    this.show3DBuildings = show;
    this.buildingStyle = style;

    if (!show) {
      this.clearOsmBuildingEntities();
      if (this.buildingsTileset) this.buildingsTileset.show = false;
      return;
    }

    // 1. Direct OpenStreetMap Overpass extrusion (100% token-free, open data)
    if (this.cachedOsmJson) {
      this.renderOsm3DBuildings(this.cachedOsmJson, style);
      return;
    }

    // Guard against a second toggle landing while the Overpass fetch is still
    // in flight — that raced two primitives (a leak) and two status flickers.
    if (this._buildingsFetching) return;

    if (this.currentDrawPoints && this.currentDrawPoints.length > 0 && typeof OSMEnricher !== 'undefined') {
      this._buildingsFetching = true;
      try {
        if (onStatus) onStatus('Fetching OpenStreetMap 3D buildings…');
        const rawPoints = this.currentDrawPoints.map(p => ({ lat: p.lat, lon: p.lon }));
        const bbox = OSMEnricher.calculateBBox(rawPoints, 350);
        if (bbox) {
          const osmJson = await OSMEnricher.fetchOSMData(bbox, onStatus);
          // A toggle-off (or teardown) during the await wins — don't draw.
          if (osmJson && this.show3DBuildings && this.viewer) {
            this.cachedOsmJson = osmJson;
            this.renderOsm3DBuildings(osmJson, style);
            if (onStatus) onStatus('');
            return;
          }
        }
      } catch (err) {
        console.warn('Direct Overpass building fetch failed, checking Cesium ion fallback:', err);
      } finally {
        this._buildingsFetching = false;
      }
    }

    // A toggle-off (or teardown) while the Overpass fetch was running wins.
    if (!this.show3DBuildings || !this.viewer) return;

    // 2. Fallback to Cesium ion global 3D tiles if token available
    if (!this.buildingsTileset) {
      try {
        if (typeof Cesium.createOsmBuildingsAsync === 'function') {
          this.buildingsTileset = await Cesium.createOsmBuildingsAsync();
        } else {
          this.buildingsTileset = await Cesium.Cesium3DTileset.fromIonAssetId(96188);
        }
        this.viewer.scene.primitives.add(this.buildingsTileset);
      } catch (err) {
        if (onStatus) onStatus('');
        this._notifyError(err);
        this.show3DBuildings = false;
        return;
      }
    }

    this.buildingsTileset.show = true;
    this.apply3DBuildingStyle(style);
    this._requestRender();
    if (onStatus) onStatus('');
  }

  /**
   * Extrude raw OpenStreetMap Overpass building footprints into one batched GPU
   * primitive. Geometry build lives in src/map/globe3d/buildings.js; this owns
   * the scene primitive's lifecycle.
   */
  renderOsm3DBuildings(osmJson, style = 'glass') {
    this.clearOsmBuildingEntities();
    if (!this.viewer || typeof GSRGlobe3DBuildings === 'undefined') return;
    const prim = GSRGlobe3DBuildings.buildPrimitive(osmJson, style);
    if (prim) {
      this.buildingPrimitive = prim;
      this.viewer.scene.primitives.add(prim);
    }
  }

  clearOsmBuildingEntities() {
    if (this.buildingPrimitive) {
      this.viewer.scene.primitives.remove(this.buildingPrimitive);
      this.buildingPrimitive = null;
    }
    if (this.osmBuildingEntities && this.osmBuildingEntities.length > 0) {
      this.osmBuildingEntities.forEach(ent => this.viewer.entities.remove(ent));
      this.osmBuildingEntities = [];
    }
  }

  /**
   * Apply architectural 3D Tile styling
   */
  apply3DBuildingStyle(style) {
    this.buildingStyle = style;

    // Re-render local OSM extruded buildings if active
    if (this.cachedOsmJson) {
      this.renderOsm3DBuildings(this.cachedOsmJson, style);
      this._requestRender();
      return;
    }

    // Otherwise update the Cesium ion 3D-tiles style.
    if (!this.buildingsTileset) return;
    this.buildingsTileset.style = new Cesium.Cesium3DTileStyle({
      color: GSRGlobe3DBuildings.tileStyleExpression(style),
      show: true
    });
    this._requestRender();
  }

  /**
   * Toggle 3D Volumetric RF Expanse (street-filling electromagnetic fluid)
   * @param {boolean} show
   * @param {'triband'|'815'|'868'|'915'|'fog'} [mode='triband']
   * @param {number} [height=25.0]
   * @param {number} [opacity=0.45]
   */
  toggle3DRf(show, mode = 'triband', height = 25.0, opacity = 0.45) {
    this.showRfVolumetric = show;
    this.rfMode = mode;
    this.rfHeight = height;
    this.rfOpacity = opacity;

    this.clearRfEntities();
    if (show && this.currentAnalyzer && this.currentDrawPoints.length > 0) {
      this.render3DRfExpanse(this.currentAnalyzer, this.currentDrawPoints);
    }
    this._requestRender();
  }

  /**
   * Render the 3D Volumetric RF Expanse (glowing semi-dome fluid slugs). The
   * geometry build lives in src/map/globe3d/rf_expanse.js; this owns the scene
   * primitive's lifecycle.
   */
  render3DRfExpanse(analyzer, drawPoints) {
    this.clearRfEntities();
    if (!this.viewer || typeof GSRGlobe3DRf === 'undefined') return;
    const prim = GSRGlobe3DRf.buildPrimitive(analyzer, drawPoints, {
      mode: this.rfMode, height: this.rfHeight, opacity: this.rfOpacity
    });
    if (prim) {
      this.rfPrimitive = prim;
      this.viewer.scene.primitives.add(prim);
    }
  }

  clearRfEntities() {
    if (this.rfPrimitive) {
      this.viewer.scene.primitives.remove(this.rfPrimitive);
      this.rfPrimitive = null;
    }
  }

  /**
   * Initialize 3D glowing scrub marker
   */
  _initScrubEntity() {
    this.scrubEntity = this.viewer.entities.add({
      id: 'biomap-scrub-marker',
      show: false,
      position: Cesium.Cartesian3.ZERO,
      point: {
        pixelSize: 12,
        color: Cesium.Color.fromCssColorString('#00d4ff'),
        outlineColor: Cesium.Color.WHITE,
        outlineWidth: 2,
        disableDepthTestDistance: Number.POSITIVE_INFINITY
      }
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

    const pos = Cesium.Cartesian3.fromDegrees(lon, lat, Math.max(0, height) + 2.0);
    this.scrubEntity.position = pos;
    this.scrubEntity.show = true;
  }

  /**
   * Register a callback fired as (peakIndex, {x, y}) when the user clicks a
   * peak spire — the 3D counterpart of a peak-marker click on the 2D map.
   * peakIndex is the index into analyzer.peaks; {x, y} is the click position
   * within the canvas so the host can place its popup. See globe3d_view.js.
   */
  onPeakClick(cb) {
    this._peakClickCb = (typeof cb === 'function') ? cb : null;
  }

  /**
   * Register a callback fired as (drawPointOrigIdx, {lat, lon}) while the
   * pointer is over the 3D track, or (null) when it leaves — the 3D
   * counterpart of hovering the 2D map path. See _setupCameraControls() 5c.
   */
  onScrubHover(cb) {
    this._scrubHoverCb = (typeof cb === 'function') ? cb : null;
  }

  /**
   * Ellipsoid-pick at a canvas position, then return the nearest drawn track
   * point ({origIdx, lat, lon}) when the pointer is within a camera-height
   * scaled radius of the line, else null.
   */
  _pickTrackPoint(windowPos) {
    if (!this.viewer || !windowPos || this.currentDrawPoints.length === 0) return null;
    const scene = this.viewer.scene;
    const cart = this.viewer.camera.pickEllipsoid(windowPos, scene.globe.ellipsoid);
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
      if (dSq < bestSq) { bestSq = dSq; best = p; }
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
    const range = Math.max(50, Cesium.Cartesian3.distance(camera.positionWC, target));
    camera.lookAt(target, new Cesium.HeadingPitchRange(camera.heading, camera.pitch, range));
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
    if (!this.viewer || !analyzer || !analyzer.raw || analyzer.raw.length === 0) return;

    const { drawPoints: providedDrawPoints, isPreview = false, colorMetric, colorRange, clusterPolygons } = opts;
    this.currentClusterPolygons = Array.isArray(clusterPolygons) ? clusterPolygons : [];

    if (colorMetric) this.activeColoringMetric = colorMetric;
    this.externalColorRange =
      (colorRange && isFinite(colorRange.min) && isFinite(colorRange.max)) ? colorRange : null;

    // Track the 2D sidebar sliders the host forwards in gpsParams.
    if (gpsParams) {
      const tw = +gpsParams.trackWeight;
      if (isFinite(tw) && tw > 0) this.trackWidth = tw;
      const pl = +gpsParams.peakLatency;
      this.peakLatency = isFinite(pl) && pl > 0 ? pl : 0;
    }

    this.currentAnalyzer = analyzer;

    const drawPoints = Array.isArray(providedDrawPoints) ? providedDrawPoints : [];
    this.currentDrawPoints = drawPoints;

    if (drawPoints.length < 2) {
      this._notifyWarn('Track contains insufficient GPS coordinates to render in 3D.');
      return;
    }

    // Filter peaks by quality threshold
    this.currentPeaks = (analyzer.peaks || []).filter(pk => !pk.excluded);

    // Clear everything from any previous track (peaks/RF leaked before)
    this.clearTrackEntities();
    this.clearPeakEntities();
    this.clearHotspotEntities();
    this.clearClusterEntities();
    this.clearRfEntities();

    this._render3DWallAndPath(analyzer, drawPoints);

    if (this.showPeaks || this.showLabels) {
      this._renderPeakSpires(analyzer, this.currentPeaks);
    }

    if (this.showHotspots) {
      this._renderHotspots(analyzer);
    }

    if (this.showClusters) {
      this._renderClusterBlobs();
    }

    if (this.showRfVolumetric) {
      this.render3DRfExpanse(analyzer, drawPoints);
    }

    this._requestRender();

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
    if (this.requestRenderMode && this.viewer && this.viewer.scene) {
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
    if (this._cesiumColorLutKey === key && this._cesiumColorLut) return this._cesiumColorLut;
    const hexLut = MapColors.getColorLut(metric, minVal, maxVal);
    this._cesiumColorLut = hexLut.map((hex) => Cesium.Color.fromCssColorString(hex).withAlpha(0.85));
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
      const gapBefore = (p.time - drawPoints[i - 1].time) > 15.0;
      const gapAfter = (drawPoints[i + 1].time - p.time) > 15.0;

      let keep = p.isRfPeak || gapBefore || gapAfter
        || stride >= maxStride
        || (p.time - drawPoints[kept].time) > 10.0;

      if (!keep && stride >= 2) {
        const b = bucketOf(colorSeries[p.origIdx] ?? minVal);
        const h = heightAt(p.origIdx);
        if (b !== keptBucket || Math.abs(h - keptH) > 1.5) {
          keep = true;
        } else {
          const a = drawPoints[kept];
          const c = drawPoints[i + 1];
          const x1 = p.lon - a.lon, y1 = p.lat - a.lat;
          const x2 = c.lon - p.lon, y2 = c.lat - p.lat;
          if (Math.abs(Math.atan2(x1 * y2 - y1 * x2, x1 * x2 + y1 * y2)) > 0.07) keep = true; // ~4°
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
    const colorSeries = this._getMetricSeries(analyzer, metric);
    const heightMetric = HEIGHT_CAPABLE_METRICS.has(metric) ? metric : this.heightMetric;
    const heightSeries = (heightMetric === metric)
      ? colorSeries
      : this._getMetricSeries(analyzer, heightMetric);

    // Colour normalisation range: the host's legend range when it owns it
    // (2D view is the source of truth), otherwise computed over drawn points.
    let minVal = Infinity;
    let maxVal = -Infinity;

    if (this.externalColorRange) {
      minVal = this.externalColorRange.min;
      maxVal = this.externalColorRange.max;
    } else {
      for (let i = 0; i < drawPoints.length; i++) {
        const idx = drawPoints[i].origIdx;
        const v = colorSeries[idx];
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
    const bucketOf = (v) => (range > 1e-9
      ? Math.max(0, Math.min(NB - 1, Math.floor(((v - minVal) / range) * NB)))
      : (NB >> 1));
    const colorLut = this._getCesiumColorLut(metric, minVal, maxVal);
    const heightAt = (idx) => this.baseHeight + Math.max(0, heightSeries[idx] ?? 0) * this.extrusionScale;

    // Thin the path for the wall only (currentDrawPoints stays full-resolution
    // for hover / camera / scrub). Keeps corners, colour-bucket changes and
    // >1.5 m height steps; drops straight, flat, same-colour runs.
    const wallPts = this._decimateForWall(drawPoints, colorSeries, heightAt, bucketOf, minVal);

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
    let runPos = null;      // Cartesian3[]
    let runMax = null;      // number[] (max wall heights, per vertex)
    let runBucket = -1;
    let instanceSeq = 0;

    const flushRun = () => {
      if (!runPos || runPos.length < 2) { runPos = runMax = null; return; }
      try {
        wallInstances.push(new Cesium.GeometryInstance({
          geometry: new Cesium.WallGeometry({
            positions: runPos,
            minimumHeights: new Array(runPos.length).fill(0.0),
            maximumHeights: runMax,
            // POSITION-only: the appearance is flat/unlit, so normals would be
            // computed and uploaded for nothing.
            vertexFormat: Cesium.PerInstanceColorAppearance.FLAT_VERTEX_FORMAT
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(colorLut[runBucket] || colorLut[0])
          },
          id: `biomap-wall-${instanceSeq++}`
        }));
      } catch (err) {
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
      const bucket = bucketOf((v1 + v2) / 2);
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
        appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
        // Embedded host: batch geometry off the main thread so a slider drag
        // doesn't stall the whole page.
        asynchronous: this.requestRenderMode
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
            color: Cesium.Color.WHITE.withAlpha(0.7)
          }),
          clampToGround: true
        }
      });
      this.trackEntities.push(groundEntity);
    }
  }

  /**
   * Ground position for a peak/hotspot marker, shifted back by the Peak-latency
   * slider so the spire lands on the GPS fix `peakLatency` seconds before the
   * arousal peak — the 3D counterpart of map.js:_resolveLatencyIndex. Height and
   * value still come from `peak.index` (the actual peak sample), matching the 2D
   * map, which keeps the amplitude from the peak while planting the marker at the
   * shifted fix.
   */
  _latencyCoords(analyzer, peak) {
    const lat = this.peakLatency || 0;
    if (!(lat > 0) || typeof analyzer.findClosestIndex !== 'function') {
      return analyzer.getCoordinates(peak.index);
    }
    const si = analyzer.findClosestIndex(Math.max(0, (peak.time || 0) - lat));
    return analyzer.getCoordinates(si >= 0 ? si : peak.index);
  }

  /**
   * Render the 3D peak markers (a small circle just above the wall top, no
   * vertical stalk) and their labels.
   */
  _renderPeakSpires(analyzer, peaks) {
    if (!peaks || peaks.length === 0) return;
    if (!this.showPeaks && !this.showLabels) return;

    const metric = this.activeColoringMetric;
    const heightMetric = HEIGHT_CAPABLE_METRICS.has(metric) ? metric : this.heightMetric;
    const heightSeries = this._getMetricSeries(analyzer, heightMetric);

    const allPeaks = analyzer.peaks || [];

    peaks.forEach((peak, i) => {
      if (peak.qualityScore < this.minPeakQuality) return;

      // Only labelled peaks get floating text — an unlabelled peak is just its
      // circle (click it to add a label).
      const labelText = (peak.label && peak.label.trim()) ? peak.label.trim() : '';

      // With peaks off, the "Labels" toggle still keeps labelled peaks on
      // screen — the 2D map does the same (a labelled marker survives turning
      // "Peaks" off).
      if (!this.showPeaks && !(this.showLabels && labelText)) return;

      // Index into analyzer.peaks (NOT the filtered `peaks` arg) — this is what
      // GSRUI.updatePeakLabel()/togglePeakExclusion() expect, and what the
      // click handler reports via _peakClickCb.
      const peakIdx = allPeaks.indexOf(peak);

      // Peak position — shifted by the Peak-latency slider, like the 2D map.
      const coords = this._latencyCoords(analyzer, peak);
      if (!coords || isNaN(coords.lat) || isNaN(coords.lon)) return;
      const lat = coords.lat;
      const lon = coords.lon;

      const val = heightSeries[peak.index] ?? peak.amplitude;
      const wallHeight = this.baseHeight + Math.max(0, val) * this.extrusionScale;
      // Circle sits just above the wall top — no vertical stalk.
      const markerPos = Cesium.Cartesian3.fromDegrees(lon, lat, wallHeight + 3.0);

      // Uniform peak red (--color-peak) — a peak is a small circle on every
      // surface; quality is read from the popup, not the marker colour (matches
      // the 2D map's .peak-dot).
      const peakColor = Cesium.Color.fromCssColorString('#d10024');

      // Faint connector from the unshifted peak sample to the latency-shifted
      // marker — the 3D counterpart of the 2D dashed rose line (map.js).
      if (this.peakLatency > 0) {
        const orig = analyzer.getCoordinates(peak.index);
        if (orig && !isNaN(orig.lat) && !isNaN(orig.lon) &&
            (orig.lat !== lat || orig.lon !== lon)) {
          const conn = this.viewer.entities.add({
            name: `Peak ${i + 1} latency`,
            polyline: {
              positions: [
                Cesium.Cartesian3.fromDegrees(orig.lon, orig.lat, 1.0),
                Cesium.Cartesian3.fromDegrees(lon, lat, 1.0)
              ],
              width: 1.5,
              material: Cesium.Color.fromCssColorString('#f43f5e').withAlpha(0.35),
              clampToGround: true
            }
          });
          conn._biomapPeakIndex = peakIdx;
          this.peakEntities.push(conn);
        }
      }

      // Small circle marking the peak — the main click target.
      const beaconEntity = this.viewer.entities.add({
        name: `Peak ${i + 1}`,
        position: markerPos,
        point: {
          pixelSize: 5,
          color: peakColor,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 1,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: (labelText && this.showLabels) ? {
          text: labelText,
          font: '600 14px Inter, "Helvetica Neue", Arial, sans-serif',
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.fromCssColorString('#0b0c10'),
          outlineWidth: 3,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -14),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 6000.0)
        } : undefined
      });
      beaconEntity._biomapPeakIndex = peakIdx;
      this.peakEntities.push(beaconEntity);
    });
  }

  /**
   * Render the "memorable event" hotspots — analyzer.memorableEvents, the same
   * amplitude-selected subset the 2D map and the GSR graph mark. Each is drawn
   * as a single camera-facing red star (★) — the one glyph language shared
   * across all three surfaces (small circle = peak, red star = hotspot) — and is
   * click-tagged with its analyzer.peaks index so the label popup opens from it
   * too (a hotspot IS a peak).
   */
  _renderHotspots(analyzer) {
    const events = analyzer && analyzer.memorableEvents;
    if (!events || events.length === 0 || !this.viewer) return;

    const metric = this.activeColoringMetric;
    const heightMetric = HEIGHT_CAPABLE_METRICS.has(metric) ? metric : this.heightMetric;
    const heightSeries = this._getMetricSeries(analyzer, heightMetric);
    const allPeaks = analyzer.peaks || [];
    const hotColor = Cesium.Color.fromCssColorString('#ff1744'); // --color-hotspot

    events.forEach(peak => {
      const coords = this._latencyCoords(analyzer, peak);
      if (!coords || isNaN(coords.lat) || isNaN(coords.lon)) return;

      const peakIdx = allPeaks.indexOf(peak);
      const val = heightSeries[peak.index] ?? peak.amplitude ?? 0;
      const wallHeight = this.baseHeight + Math.max(0, val) * this.extrusionScale;
      const tipHeight = wallHeight + 11.0; // sits above the regular peak circle

      const star = this.viewer.entities.add({
        name: 'Hotspot',
        position: Cesium.Cartesian3.fromDegrees(coords.lon, coords.lat, tipHeight),
        label: {
          text: '★',
          font: '700 14px "Helvetica Neue", Arial, sans-serif',
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          fillColor: hotColor,
          outlineColor: Cesium.Color.fromCssColorString('#0b0c10'),
          outlineWidth: 2,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        }
      });
      star._biomapPeakIndex = peakIdx;
      this.hotspotEntities.push(star);
    });
  }

  /**
   * Draw the 2D map's spatial-cluster hulls as translucent ground blobs. The
   * hulls are computed by the 2D view (GSRSpatialClustering, driven by the
   * sidebar sliders) and handed in via renderData({ clusterPolygons }) so the
   * two surfaces can't drift — this class only rasterises them.
   */
  _renderClusterBlobs() {
    const polys = this.currentClusterPolygons || [];
    if (!polys.length || !this.viewer) return;

    polys.forEach(poly => {
      const ring = (poly && poly.ring) || [];
      if (ring.length < 3) return;

      const flat = [];
      for (let i = 0; i < ring.length; i++) { flat.push(ring[i][1], ring[i][0]); } // [lat,lon] -> lon,lat
      const positions = Cesium.Cartesian3.fromDegreesArray(flat);
      const baseColor = Cesium.Color.fromCssColorString(poly.color || '#ff5252');
      const fillAlpha = (poly.fillOpacity != null) ? poly.fillOpacity : 0.25;

      const fillEnt = this.viewer.entities.add({
        name: 'Stress cluster',
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: baseColor.withAlpha(fillAlpha),
          classificationType: Cesium.ClassificationType.BOTH
        }
      });
      this.clusterEntities.push(fillEnt);

      const outlineEnt = this.viewer.entities.add({
        polyline: {
          positions: positions.concat([positions[0]]),
          width: 2.0,
          material: new Cesium.PolylineDashMaterialProperty({ color: baseColor.withAlpha(0.9), dashLength: 12.0 }),
          clampToGround: true
        }
      });
      this.clusterEntities.push(outlineEnt);
    });
  }

  /**
   * Retrieve the coloring-metric series from the analyzer as plain floats.
   * Derived metrics (SERIES_FIELD) come from per-sample analyzer arrays; anything
   * else falls back to the raw GSR series.
   */
  _getMetricSeries(analyzer, metric) {
    const field = SERIES_FIELD[metric];
    if (field && analyzer[field] && analyzer[field].length > 0) {
      return analyzer[field].map(seriesValue);
    }
    if (analyzer.raw && analyzer.raw.length > 0) {
      return analyzer.raw.map(d => (d.gsr !== undefined ? d.gsr : (d.val !== undefined ? d.val : 0)));
    }
    return [];
  }

  /** Re-draw the wall + the peak/hotspot/cluster layers from the cached track. */
  _refreshTrack() {
    if (!this.currentAnalyzer || this.currentDrawPoints.length < 2) return;
    this.clearTrackEntities();
    this.clearPeakEntities();
    this.clearHotspotEntities();
    this.clearClusterEntities();
    this._render3DWallAndPath(this.currentAnalyzer, this.currentDrawPoints);
    if (this.showPeaks || this.showLabels) {
      this._renderPeakSpires(this.currentAnalyzer, this.currentPeaks);
    }
    if (this.showHotspots) this._renderHotspots(this.currentAnalyzer);
    if (this.showClusters) this._renderClusterBlobs();
    this._requestRender();
  }

  /** Set active coloring metric and refresh. */
  setColoringMetric(metric) {
    this.activeColoringMetric = metric;
    this._refreshTrack();
  }

  /** Adjust extruded wall-height scale and refresh. */
  setExtrusionScale(scale) {
    this.extrusionScale = scale;
    this._refreshTrack();
  }

  /**
   * Toggle 3D peak spires
   */
  togglePeaks(visible, minQuality = 0.0) {
    this.showPeaks = visible;
    this.minPeakQuality = minQuality;
    this.clearPeakEntities();
    if ((this.showPeaks || this.showLabels) && this.currentAnalyzer) {
      this._renderPeakSpires(this.currentAnalyzer, this.currentPeaks);
    }
    this._requestRender();
  }

  /**
   * Toggle the floating peak labels. With spires off, this still keeps the
   * labelled peaks on screen (same as the 2D map's "Labels" toggle).
   */
  toggleLabels(visible) {
    this.showLabels = visible;
    this.clearPeakEntities();
    if ((this.showPeaks || this.showLabels) && this.currentAnalyzer) {
      this._renderPeakSpires(this.currentAnalyzer, this.currentPeaks);
    }
    this._requestRender();
  }

  /**
   * Toggle the memorable-event hotspot markers (analyzer.memorableEvents).
   */
  toggleHotspots(visible) {
    this.showHotspots = visible;
    this.clearHotspotEntities();
    if (visible && this.currentAnalyzer) {
      this._renderHotspots(this.currentAnalyzer);
    }
    this._requestRender();
  }

  /**
   * Toggle the spatial-cluster ground blobs (hulls handed in by the 2D view via
   * renderData({ clusterPolygons })).
   */
  toggleClusters(visible) {
    this.showClusters = visible;
    this.clearClusterEntities();
    if (visible) this._renderClusterBlobs();
    this._requestRender();
  }

  /**
   * Clear the batched wall primitive and the ground-path entity.
   */
  clearTrackEntities() {
    if (this.wallPrimitive) {
      this.viewer.scene.primitives.remove(this.wallPrimitive);
      this.wallPrimitive = null;
    }
    this.trackEntities.forEach(ent => this.viewer.entities.remove(ent));
    this.trackEntities = [];
  }

  /**
   * Clear peak spire entities
   */
  clearPeakEntities() {
    this.peakEntities.forEach(ent => this.viewer.entities.remove(ent));
    this.peakEntities = [];
  }

  /** Clear the memorable-event hotspot entities. */
  clearHotspotEntities() {
    if (!this.viewer) return;
    this.hotspotEntities.forEach(ent => this.viewer.entities.remove(ent));
    this.hotspotEntities = [];
  }

  /** Clear the spatial-cluster ground-blob entities. */
  clearClusterEntities() {
    if (!this.viewer) return;
    this.clusterEntities.forEach(ent => this.viewer.entities.remove(ent));
    this.clusterEntities = [];
  }

  /**
   * Clear all entities
   */
  clearAll() {
    this.clearTrackEntities();
    this.clearPeakEntities();
    this.clearHotspotEntities();
    this.clearClusterEntities();
    this.clearOsmBuildingEntities();
    this.clearRfEntities();
    if (this.scrubEntity) this.scrubEntity.show = false;
  }

  /**
   * Fly camera to encompass and perfectly center the entire active track
   */
  flyToTrack() {
    if (!this.viewer || this.currentDrawPoints.length === 0) return;
    this._wakeRenderLoop();

    // Convert track points to 3D Cartesian positions
    const positions = this.currentDrawPoints.map(p => Cesium.Cartesian3.fromDegrees(p.lon, p.lat));
    
    // Compute exact 3D bounding sphere encompassing the walk
    const boundingSphere = Cesium.BoundingSphere.fromPoints(positions);

    // Isometric 45-degree pitch, looking North, with radius-proportional range
    const pitch = Cesium.Math.toRadians(-45.0);
    const heading = Cesium.Math.toRadians(0.0);
    const range = Math.max(boundingSphere.radius * 2.2, 450.0);

    const offset = new Cesium.HeadingPitchRange(heading, pitch, range);

    this.viewer.camera.flyToBoundingSphere(boundingSphere, {
      offset: offset,
      duration: 1.5
    });
  }

  /**
   * Toggle 360-degree turntable orbit around track center
   */
  toggleOrbit() {
    if (this._isOrbiting) {
      this.stopOrbit();
    } else {
      this.startOrbit();
    }
    return this._isOrbiting;
  }

  startOrbit() {
    if (!this.viewer || this.currentDrawPoints.length === 0 || this._isOrbiting) return;

    const coords = this.currentDrawPoints.map(p => Cesium.Cartographic.fromDegrees(p.lon, p.lat));
    const rectangle = Cesium.Rectangle.fromCartographicArray(coords);
    const centerCartographic = Cesium.Rectangle.center(rectangle);
    const center = Cesium.Cartographic.toCartesian(centerCartographic);

    const distance = Cesium.Cartesian3.distance(
      center,
      Cesium.Cartographic.toCartesian(Cesium.Rectangle.northwest(rectangle))
    ) * 2.5;

    let heading = this.viewer.camera.heading;
    const pitch = Cesium.Math.toRadians(-35.0);

    const orbitStep = () => {
      heading += 0.003;
      this.viewer.camera.lookAt(
        center,
        new Cesium.HeadingPitchRange(heading, pitch, Math.max(distance, 300))
      );
    };

    // Continuous rendering for the duration of the orbit — render-on-demand
    // (requestRenderMode) makes a per-tick camera animation visibly steppy.
    // Cancel any pending idle-retire so the smoothness bridge can't flip the
    // scene back to on-demand mid-orbit.
    if (this._idleRenderTimer) {
      clearTimeout(this._idleRenderTimer);
      this._idleRenderTimer = null;
    }
    this.viewer.scene.requestRenderMode = false;
    this._orbitRemoveCallback = this.viewer.clock.onTick.addEventListener(orbitStep);
    this._isOrbiting = true;
  }

  stopOrbit() {
    if (!this._isOrbiting) return;
    if (this._orbitRemoveCallback) {
      this._orbitRemoveCallback();
      this._orbitRemoveCallback = null;
    }
    this.viewer.camera.lookAtTransform(Cesium.Matrix4.IDENTITY);
    this._isOrbiting = false;
    // Back to render-on-demand (no-op when this host runs continuously anyway).
    if (this.viewer) this.viewer.scene.requestRenderMode = this.requestRenderMode;
  }

  // 3D track export (CZML / KML) lives in src/map/globe3d/exporters.js and is
  // driven from the main Export Options panel — it needs no live viewer. The 3D
  // PNG snapshot was dropped: the app's Save Canvas / Bio Map PNG covers it.
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRGlobeManager, BASEMAP_PROVIDERS, SERIES_FIELD, HEIGHT_CAPABLE_METRICS, seriesValue };
}
if (typeof window !== 'undefined') {
  window.GSRGlobeManager = GSRGlobeManager;
}
