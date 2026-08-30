/**
 * BioMapping 2.0 - 3D Globe Manager (CesiumJS)
 * Copyright (c) 2026 Christian Nold
 * Licensed under the Bio Mapping Community Licence 1.0.
 *
 * Renders biometric tracks as 3D extruded emotional ribbons/walls and
 * vertical peak spires over 3D terrain and satellite/urban basemaps.
 *
 * GSRGlobeManager is a self-contained, embeddable engine: construct it against a
 * container id, feed it an analysed track via renderData(), and tear it down with
 * destroy(). It makes no assumptions about owning the whole page — 3d.html is one
 * host; index.html could be a second (see docs/… integration notes). Page chrome
 * (sidebar, help pill) lives in the host, never here.
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
  phasicAUC: 'phasicAUC'
};

/** Unwrap one analyzer series sample ({time,val} | number) to a plain float. */
const seriesValue = (d) =>
  (d && typeof d === 'object' && 'val' in d) ? d.val : (typeof d === 'number' ? d : 0);

// Standalone GPS pipeline tuning — 3D forces a downsample and a non-zero RDP
// tolerance for frame-rate headroom, unlike map.js which honours the UI toggles.
const STANDALONE_FORCE_DOWNSAMPLE = true;
const STANDALONE_RDP_TOLERANCE = 0.00002;

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
   */
  constructor(containerId, options = {}) {
    this.containerId = containerId;
    this.viewer = null;
    this.options = options;

    // Embedding contract — a host that shares the page (index.html view tab) turns
    // keyboardFlight off so the 3D engine's window key listeners don't fight the 2D view.
    this.keyboardFlight = options.keyboardFlight !== false;
    this.doubleClickFly = options.doubleClickFly !== false;

    // Active track data cache
    this.currentAnalyzer = null;
    this.currentDrawPoints = [];
    this.currentPeaks = [];

    // Configuration & styling
    this.activeColoringMetric = options.metric || 'phasic'; // 'phasic' | 'gsr' | 'tonic' | 'arousalIndex' | 'peakDensity'
    this.extrusionScale = options.extrusionScale || 8.0;    // Meters of height per metric unit
    this.baseHeight = 2.0;                                  // Minimum base wall height in meters
    this.showPeaks = true;
    this.minPeakQuality = 0.0;
    this.showGroundPath = true;

    // Entity / primitive collections
    this.trackEntities = [];
    this.wallPrimitive = null;
    this.peakEntities = [];
    this.osmBuildingEntities = [];
    this.scrubEntity = null;
    this.buildingsTileset = null;
    this.buildingPrimitive = null;
    this.cachedOsmJson = null;

    // Teardown bookkeeping — every listener this class adds, so destroy() is exact.
    this._keyDownHandler = null;
    this._keyUpHandler = null;
    this._screenSpaceHandler = null;
    this._flightTickRemover = null;

    // 3D Volumetric RF Expanse settings
    this.showRfVolumetric = false;
    this.rfMode = 'triband'; // 'triband' | '815' | '868' | '915' | 'fog'
    this.rfHeight = 25.0;    // Volumetric ceiling in meters
    this.rfOpacity = 0.45;
    this.rfPrimitive = null;

    // Orbit camera animation
    this._isOrbiting = false;
    this._orbitRemoveCallback = null;

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
      requestRenderMode: false // Smooth continuous flight & orbit
    });

    // Set initial ArcGIS satellite basemap immediately
    this.setBasemap('satellite');

    const scene = this.viewer.scene;
    const globe = scene.globe;

    // Fast, lightweight rendering settings
    globe.enableLighting = false;
    globe.depthTestAgainstTerrain = false;
    scene.fog.enabled = true;
    scene.fog.density = 0.0001;

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

    // 5. Double-Click to fly to point (Google Earth style). Bound to the viewer's
    // own canvas, never document — kept in _screenSpaceHandler for destroy().
    if (this.doubleClickFly) {
      this._screenSpaceHandler = new Cesium.ScreenSpaceEventHandler(scene.canvas);
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

    // 6. Real-time WASD / Arrow Key flying controls (opt-out for shared-page hosts)
    if (this.keyboardFlight) {
      this._setupKeyboardFlight();
    }
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
    this.clearAll();

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
    if (this._screenSpaceHandler && !this._screenSpaceHandler.isDestroyed()) {
      this._screenSpaceHandler.destroy();
    }
    this._screenSpaceHandler = null;

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
    layers.removeAll();
    const provider = this._createImageryProvider(type);
    if (provider) {
      layers.addImageryProvider(provider);
    }
  }

  /**
   * Toggle 3D Buildings: Uses direct OpenStreetMap Overpass vector extrusion (token-free)
   * or falls back to Cesium ion 3D Tiles if configured.
   * @param {boolean} show
   * @param {'glass'|'dark'|'monochrome'|'realistic'} [style='glass']
   * @param {Function} [onStatus]
   */
  async toggle3DBuildings(show, style = 'glass', onStatus) {
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

    if (this.currentDrawPoints && this.currentDrawPoints.length > 0 && typeof OSMEnricher !== 'undefined') {
      try {
        if (onStatus) onStatus('Fetching OpenStreetMap 3D buildings…');
        const rawPoints = this.currentDrawPoints.map(p => ({ lat: p.lat, lon: p.lon }));
        const bbox = OSMEnricher.calculateBBox(rawPoints, 350);
        if (bbox) {
          const osmJson = await OSMEnricher.fetchOSMData(bbox, onStatus);
          if (osmJson) {
            this.cachedOsmJson = osmJson;
            this.renderOsm3DBuildings(osmJson, style);
            if (onStatus) onStatus('');
            return;
          }
        }
      } catch (err) {
        console.warn('Direct Overpass building fetch failed, checking Cesium ion fallback:', err);
      }
    }

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
    if (onStatus) onStatus('');
  }

  /**
   * Extrude 3D building polygons from raw OpenStreetMap Overpass data
   * (100% token-free, no Cesium ion account needed).
   */
  /**
   * Extrude 3D building polygons from raw OpenStreetMap Overpass data
   * (Batched into a single GPU primitive for high 60 FPS performance).
   */
  renderOsm3DBuildings(osmJson, style = 'glass') {
    this.clearOsmBuildingEntities();
    if (!osmJson || !osmJson.elements) return;

    // Parse nodes and ways from OSM JSON
    const nodeMap = new Map();
    const buildingWays = [];

    for (const el of osmJson.elements) {
      if (el.type === 'node') {
        nodeMap.set(el.id, { lat: el.lat, lon: el.lon });
      }
    }

    for (const el of osmJson.elements) {
      if (el.type === 'way' && el.tags && el.tags.building) {
        const coords = [];
        for (const nid of el.nodes) {
          const pt = nodeMap.get(nid);
          if (pt) coords.push(pt);
        }
        if (coords.length >= 3) {
          el.coordinates = coords;
          buildingWays.push(el);
        }
      }
    }

    if (buildingWays.length === 0) return;

    // Determine color
    let fillColor;
    if (style === 'glass') {
      fillColor = Cesium.Color.fromCssColorString('#00d4ff').withAlpha(0.35);
    } else if (style === 'dark') {
      fillColor = Cesium.Color.fromCssColorString('#242833');
    } else if (style === 'monochrome') {
      fillColor = Cesium.Color.fromCssColorString('#e4e7ee');
    } else {
      fillColor = Cesium.Color.fromCssColorString('#cfc4b4');
    }

    const isTranslucent = (style === 'glass');
    const instances = [];

    // Build geometry instances into 1 single GPU draw call
    for (let i = 0; i < buildingWays.length; i++) {
      const way = buildingWays[i];
      const degreesArray = [];
      for (const pt of way.coordinates) {
        degreesArray.push(pt.lon, pt.lat);
      }

      let heightMeters = 9.0; // Default 3 stories
      if (way.tags.height) {
        const h = parseFloat(way.tags.height);
        if (!isNaN(h) && h > 0) heightMeters = h;
      } else if (way.tags['building:levels']) {
        const lvls = parseFloat(way.tags['building:levels']);
        if (!isNaN(lvls) && lvls > 0) heightMeters = lvls * 3.5;
      } else if (way.tags.building === 'commercial' || way.tags.building === 'apartments' || way.tags.building === 'office') {
        heightMeters = 16.0;
      } else if (way.tags.building === 'shed' || way.tags.building === 'garage') {
        heightMeters = 4.0;
      }

      try {
        const polygonGeometry = new Cesium.PolygonGeometry({
          polygonHierarchy: new Cesium.PolygonHierarchy(
            Cesium.Cartesian3.fromDegreesArray(degreesArray)
          ),
          height: 0.0,
          extrudedHeight: heightMeters,
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
        });

        instances.push(new Cesium.GeometryInstance({
          geometry: polygonGeometry,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(fillColor)
          },
          id: `osm-building-${i}`
        }));
      } catch (err) {
        // Skip invalid/degenerate polygons cleanly
      }
    }

    if (instances.length > 0) {
      this.buildingPrimitive = new Cesium.Primitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({
          translucent: isTranslucent,
          closed: true
        }),
        asynchronous: true
      });
      this.viewer.scene.primitives.add(this.buildingPrimitive);
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
      return;
    }

    // Otherwise update Cesium 3D Tile style
    if (!this.buildingsTileset) return;

    let colorExpression;
    if (style === 'glass') {
      colorExpression = "color('rgba(52, 100, 138, 0.45)')";
    } else if (style === 'dark') {
      colorExpression = "color('#1c202a', 1.0)";
    } else if (style === 'monochrome') {
      colorExpression = "color('#f0f2f6', 1.0)";
    } else {
      colorExpression = "color('#d6cdc0', 1.0)";
    }

    this.buildingsTileset.style = new Cesium.Cesium3DTileStyle({
      color: colorExpression,
      show: true
    });
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
  }

  /**
   * Render 3D Volumetric RF Expanse as smooth, glowing semi-dome fluid slugs
   */
  render3DRfExpanse(analyzer, drawPoints) {
    this.clearRfEntities();
    if (!analyzer || !drawPoints || drawPoints.length === 0) return;

    const raw = analyzer.raw || [];
    if (raw.length === 0) return;

    // 1. Gather all points with GPS coordinates and inspect RSSI data
    const rfPoints = [];
    let min815 = Infinity, max815 = -Infinity;
    let min868 = Infinity, max868 = -Infinity;
    let min915 = Infinity, max915 = -Infinity;
    let minFog = Infinity, maxFog = -Infinity;

    for (let i = 0; i < drawPoints.length; i++) {
      const pt = drawPoints[i];
      if (!pt || isNaN(pt.lat) || isNaN(pt.lon)) continue;

      const rawRow = raw[pt.origIdx] || {};
      const r815 = rawRow.rssi_815 ?? rawRow.r815 ?? rawRow.r_815;
      const r868 = rawRow.rssi_868 ?? rawRow.r868 ?? rawRow.r_868;
      const r915 = rawRow.rssi_915 ?? rawRow.r915 ?? rawRow.r_915;
      const fog  = rawRow.em_fog ?? rawRow.emFog ?? rawRow.fog;

      const has815 = (r815 !== undefined && !isNaN(r815));
      const has868 = (r868 !== undefined && !isNaN(r868));
      const has915 = (r915 !== undefined && !isNaN(r915));
      const hasFog = (fog !== undefined && !isNaN(fog));

      if (has815) { if (r815 < min815) min815 = r815; if (r815 > max815) max815 = r815; }
      if (has868) { if (r868 < min868) min868 = r868; if (r868 > max868) max868 = r868; }
      if (has915) { if (r915 < min915) min915 = r915; if (r915 > max915) max915 = r915; }
      if (hasFog) { if (fog < minFog) minFog = fog; if (fog > maxFog) maxFog = fog; }

      rfPoints.push({
        lat: pt.lat,
        lon: pt.lon,
        origIdx: pt.origIdx,
        r815: has815 ? r815 : null,
        r868: has868 ? r868 : null,
        r915: has915 ? r915 : null,
        fog: hasFog ? fog : null,
        hasRf: (has815 || has868 || has915 || hasFog)
      });
    }

    if (rfPoints.length === 0) return;

    const hasMeasuredRf = rfPoints.some(p => p.hasRf);

    // If dataset does not have hardware radio chips, generate ambient RF field
    if (!hasMeasuredRf) {
      min815 = 0; max815 = 1;
      min868 = 0; max868 = 1;
      min915 = 0; max915 = 1;
      minFog = 0; maxFog = 1;

      for (let i = 0; i < rfPoints.length; i++) {
        const frac = i / Math.max(1, rfPoints.length - 1);
        rfPoints[i].r815 = 0.35 + 0.65 * Math.sin(frac * Math.PI * 4);
        rfPoints[i].r868 = 0.35 + 0.65 * Math.sin(frac * Math.PI * 3 + 1.2);
        rfPoints[i].r915 = 0.35 + 0.65 * Math.cos(frac * Math.PI * 5 + 0.5);
        rfPoints[i].fog  = 0.3 + 0.7 * Math.sin(frac * Math.PI * 2);
      }
    } else {
      if (!isFinite(min815) || !isFinite(max815) || min815 >= max815) { min815 = -92.0; max815 = -50.0; }
      if (!isFinite(min868) || !isFinite(max868) || min868 >= max868) { min868 = -92.0; max868 = -50.0; }
      if (!isFinite(min915) || !isFinite(max915) || min915 >= max915) { min915 = -92.0; max915 = -50.0; }
      if (!isFinite(minFog) || !isFinite(maxFog) || minFog >= maxFog) { minFog = 0.0; maxFog = 100.0; }
    }

    const mode = this.rfMode || 'triband';
    const baseCeiling = this.rfHeight || 25.0;
    const opacity = this.rfOpacity || 0.45;
    const instances = [];

    // Spatial step for smooth fluid slug overlap
    const sampleStep = Math.max(1, Math.floor(rfPoints.length / 50));

    for (let i = 0; i < rfPoints.length; i += sampleStep) {
      const pt = rfPoints[i];

      // Normalize band intensities [0.0 -> 1.0]
      const norm815 = Math.max(0.0, Math.min(1.0, hasMeasuredRf ? ((pt.r815 - min815) / (max815 - min815)) : pt.r815));
      const norm868 = Math.max(0.0, Math.min(1.0, hasMeasuredRf ? ((pt.r868 - min868) / (max868 - min868)) : pt.r868));
      const norm915 = Math.max(0.0, Math.min(1.0, hasMeasuredRf ? ((pt.r915 - min915) / (max915 - min915)) : pt.r915));
      const normFog = Math.max(0.0, Math.min(1.0, hasMeasuredRf ? ((pt.fog - minFog) / (maxFog - minFog)) : pt.fog));

      let r = 0, g = 0, b = 0, intensity = 0;

      if (mode === 'triband') {
        // Additive luminous RGB fluid mixing
        r = Math.min(1.0, 0.15 + norm815 * 0.85);
        g = Math.min(1.0, 0.15 + norm868 * 0.85);
        b = Math.min(1.0, 0.15 + norm915 * 0.85);
        intensity = Math.max(norm815, norm868, norm915, 0.25);
      } else if (mode === '815') {
        // 815 MHz: Vivid glowing Coral Red
        r = 1.0;
        g = 0.12 + 0.25 * (1.0 - norm815);
        b = 0.18 + 0.2 * (1.0 - norm815);
        intensity = Math.max(0.2, norm815);
      } else if (mode === '868') {
        // 868 MHz: Vivid glowing Emerald Green
        r = 0.05;
        g = 1.0;
        b = 0.25 + 0.3 * (1.0 - norm868);
        intensity = Math.max(0.2, norm868);
      } else if (mode === '915') {
        // 915 MHz: Vivid glowing Electric Cyan / Blue
        r = 0.0;
        g = 0.65 + 0.35 * norm915;
        b = 1.0;
        intensity = Math.max(0.2, norm915);
      } else {
        // EM Fog Index: Radiant Magenta / Purple
        r = 0.88;
        g = 0.22;
        b = 1.0;
        intensity = Math.max(0.2, normFog);
      }

      // Smooth semi-dome radius and altitude ceiling
      const domeRadius = 24.0 + 32.0 * intensity;
      const domeHeight = 8.0 + (baseCeiling - 8.0) * intensity;

      try {
        const domeGeometry = new Cesium.EllipsoidGeometry({
          radii: new Cesium.Cartesian3(domeRadius, domeRadius, domeHeight),
          vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
        });

        const modelMatrix = Cesium.Transforms.eastNorthUpToFixedFrame(
          Cesium.Cartesian3.fromDegrees(pt.lon, pt.lat, 0.0)
        );

        const cesiumColor = new Cesium.Color(r, g, b, opacity * (0.45 + 0.55 * intensity));

        instances.push(new Cesium.GeometryInstance({
          geometry: domeGeometry,
          modelMatrix: modelMatrix,
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(cesiumColor)
          },
          id: `rf-slug-${i}`
        }));
      } catch (err) {
        // Skip geometry error cleanly
      }
    }

    if (instances.length > 0) {
      this.rfPrimitive = new Cesium.Primitive({
        geometryInstances: instances,
        appearance: new Cesium.PerInstanceColorAppearance({
          translucent: true,
          closed: true
        }),
        asynchronous: false
      });
      this.viewer.scene.primitives.add(this.rfPrimitive);
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
   * Run the full GPS filter chain for the standalone 3d.html page and return
   * displayable draw points.
   *
   * This mirrors GSRMapManager._getOrBuildDrawPoints() (src/map/map.js) minus its
   * per-track cache, and is the designated extraction point: a future shared
   * GpsPipeline.buildDrawPoints(analyzer, params, opts) would replace this body and
   * let an in-app host feed globe3d the drawPoints it already built for Leaflet
   * (renderData's `drawPoints` option) instead of re-running the chain here.
   */
  _computeDrawPointsStandalone(analyzer, data, gpsParams) {
    const p = gpsParams || (typeof GSR_CONST !== 'undefined' ? GSR_CONST.GPS_DEFAULT : {});
    let gpsPoints = [];
    for (let i = 0; i < data.length; i++) {
      if (data[i].hasGps && !isNaN(data[i].lat) && !isNaN(data[i].lon)) {
        gpsPoints.push({ ...data[i], origIdx: i });
      }
    }

    if (gpsPoints.length === 0) return [];

    gpsPoints = GpsPipeline.applyHdopGate(gpsPoints, p.maxHdop || 3.0);
    gpsPoints = GpsPipeline.applyFixTypeGate(gpsPoints); // defaults minFixType = 2, matching map.js

    const smoothing = p.smoothing || 0.5;
    const kalmanR   = p.kalmanR || 10;
    gpsPoints = GpsPipeline.applyPreKalmanFilters(gpsPoints, smoothing, p.maxSpeed || 3.0);

    if (analyzer.snappedGps) {
      gpsPoints = GpsPipeline.applySnapCorrection(gpsPoints, analyzer.snappedGps);
    }

    gpsPoints = GpsFilter.applyKalman(gpsPoints, smoothing, kalmanR);

    // Reconstruct full 10 Hz filtered GPS path
    GpsPipeline.reconstructFilteredGpsCached(analyzer, data, gpsPoints);

    const filteredGps = analyzer.filteredGps;
    let drawPoints = [];
    for (let i = 0; i < data.length; i++) {
      const fg = filteredGps[i];
      if (fg && !isNaN(fg.lat) && !isNaN(fg.lon)) {
        drawPoints.push({
          ...data[i],
          lat: fg.lat,
          lon: fg.lon,
          origIdx: i,
          isRfPeak: !!(analyzer.rfPeakIndices && analyzer.rfPeakIndices.has(i))
        });
      }
    }

    drawPoints = GpsPipeline.downsampleForDisplay(
      drawPoints, analyzer.sampleRate || 10.0, STANDALONE_FORCE_DOWNSAMPLE, analyzer.rfPeakIndices);
    drawPoints = GpsFilter.applyRDP(
      drawPoints, p.rdpTolerance || STANDALONE_RDP_TOLERANCE, analyzer.rfPeakIndices);

    return drawPoints;
  }

  /**
   * Render a BioMapping track in 3D.
   * @param {GSRAnalyzer} analyzer  Analysed track instance.
   * @param {object} gpsParams      GPS filter parameters (used only when `drawPoints` is omitted).
   * @param {object} [opts]
   * @param {Array}   [opts.drawPoints]  Pre-computed draw points from the host; skips the
   *                                     standalone GPS chain entirely.
   * @param {boolean} [opts.isPreview=false]  Suppress the initial fly-to-track.
   */
  renderData(analyzer, gpsParams, opts = {}) {
    if (!this.viewer || !analyzer || !analyzer.raw || analyzer.raw.length === 0) return;

    // Back-compat: renderData(analyzer, params, true) still means isPreview.
    if (typeof opts === 'boolean') opts = { isPreview: opts };
    const { drawPoints: providedDrawPoints, isPreview = false } = opts;

    this.currentAnalyzer = analyzer;

    const drawPoints = providedDrawPoints
      || this._computeDrawPointsStandalone(analyzer, analyzer.raw, gpsParams);
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
    this.clearRfEntities();

    this._render3DWallAndPath(analyzer, drawPoints);

    if (this.showPeaks) {
      this._renderPeakSpires(analyzer, this.currentPeaks);
    }

    if (this.showRfVolumetric) {
      this.render3DRfExpanse(analyzer, drawPoints);
    }

    if (!isPreview) {
      this.flyToTrack();
    }
  }

  /**
   * Build the extruded arousal wall (one batched GPU primitive, one instance per
   * segment for its own colour) and the clamped ground polyline.
   */
  _render3DWallAndPath(analyzer, drawPoints) {
    if (drawPoints.length < 2) return;

    const metric = this.activeColoringMetric;
    const series = this._getMetricSeries(analyzer, metric);

    // Calculate metric min and max for color normalization
    let minVal = Infinity;
    let maxVal = -Infinity;

    for (let i = 0; i < drawPoints.length; i++) {
      const idx = drawPoints[i].origIdx;
      const v = series[idx];
      if (v != null && !isNaN(v)) {
        if (v < minVal) minVal = v;
        if (v > maxVal) maxVal = v;
      }
    }

    if (!isFinite(minVal) || !isFinite(maxVal) || minVal === maxVal) {
      minVal = 0;
      maxVal = 1;
    }

    // One GeometryInstance per segment (keeps per-segment colour), collapsed into
    // a single Primitive / draw call — the shape renderOsm3DBuildings() uses.
    const wallInstances = [];
    const groundPositions = [];

    for (let i = 0; i < drawPoints.length - 1; i++) {
      const p1 = drawPoints[i];
      const p2 = drawPoints[i + 1];

      // Time gap check (e.g. paused / lost fix > 15 seconds)
      const dt = Math.abs(p2.time - p1.time);
      if (dt > 15.0) continue;

      const val1 = series[p1.origIdx] ?? minVal;
      const val2 = series[p2.origIdx] ?? minVal;
      const avgVal = (val1 + val2) / 2;

      const h1 = this.baseHeight + Math.max(0, val1) * this.extrusionScale;
      const h2 = this.baseHeight + Math.max(0, val2) * this.extrusionScale;

      const pos1 = Cesium.Cartesian3.fromDegrees(p1.lon, p1.lat);
      const pos2 = Cesium.Cartesian3.fromDegrees(p2.lon, p2.lat);

      groundPositions.push(pos1);
      if (i === drawPoints.length - 2) groundPositions.push(pos2);

      const hexColor = MapColors.getColorForMetric(metric, avgVal, minVal, maxVal);
      const cesiumColor = Cesium.Color.fromCssColorString(hexColor).withAlpha(0.85);

      try {
        wallInstances.push(new Cesium.GeometryInstance({
          geometry: new Cesium.WallGeometry({
            positions: [pos1, pos2],
            minimumHeights: [0.0, 0.0],
            maximumHeights: [h1, h2],
            vertexFormat: Cesium.PerInstanceColorAppearance.VERTEX_FORMAT
          }),
          attributes: {
            color: Cesium.ColorGeometryInstanceAttribute.fromColor(cesiumColor)
          },
          id: `biomap-wall-${i}`
        }));
      } catch (err) {
        // Skip degenerate (zero-length) segments cleanly
      }
    }

    if (wallInstances.length > 0) {
      this.wallPrimitive = new Cesium.Primitive({
        geometryInstances: wallInstances,
        // flat: match the old unlit `wall.material = color` look (scene lighting is off)
        appearance: new Cesium.PerInstanceColorAppearance({ flat: true, translucent: true, closed: false }),
        asynchronous: false
      });
      this.viewer.scene.primitives.add(this.wallPrimitive);
    }

    // Ground outline track
    if (this.showGroundPath && groundPositions.length >= 2) {
      const groundEntity = this.viewer.entities.add({
        name: 'Biomap Ground Path',
        polyline: {
          positions: groundPositions,
          width: 3.0,
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
   * Render 3D vertical peak spires and labels
   */
  _renderPeakSpires(analyzer, peaks) {
    if (!peaks || peaks.length === 0) return;

    const metric = this.activeColoringMetric;
    const series = this._getMetricSeries(analyzer, metric);

    peaks.forEach((peak, i) => {
      if (peak.qualityScore < this.minPeakQuality) return;

      // Peak position
      const coords = analyzer.getCoordinates(peak.index);
      if (!coords || isNaN(coords.lat) || isNaN(coords.lon)) return;
      const lat = coords.lat;
      const lon = coords.lon;

      const val = series[peak.index] ?? peak.amplitude;
      const wallHeight = this.baseHeight + Math.max(0, val) * this.extrusionScale;
      const spireHeight = wallHeight + 15.0; // Spire shoots above wall

      const basePos = Cesium.Cartesian3.fromDegrees(lon, lat, 0);
      const topPos = Cesium.Cartesian3.fromDegrees(lon, lat, spireHeight);

      // Color code by quality score (High = Green, Med = Amber, Low = Red)
      const qScore = peak.qualityScore || 0.5;
      const spireColorHex = qScore >= 0.7 ? '#00e575' : (qScore >= 0.4 ? '#ffaa00' : '#ff3344');
      const spireColor = Cesium.Color.fromCssColorString(spireColorHex);

      // Vertical spire line
      const spireEntity = this.viewer.entities.add({
        name: `Peak ${i + 1}`,
        polyline: {
          positions: [basePos, topPos],
          width: 3.0,
          material: new Cesium.PolylineGlowMaterialProperty({
            glowPower: 0.4,
            color: spireColor
          })
        }
      });
      this.peakEntities.push(spireEntity);

      // Glowing Beacon Sphere at top of spire
      const beaconEntity = this.viewer.entities.add({
        position: topPos,
        point: {
          pixelSize: 10,
          color: spireColor,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 2,
          disableDepthTestDistance: Number.POSITIVE_INFINITY
        },
        label: {
          text: `Peak ${i + 1}\n+${peak.amplitude.toFixed(1)} nS`,
          font: '11px Inter, sans-serif',
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          fillColor: Cesium.Color.WHITE,
          outlineColor: Cesium.Color.BLACK,
          outlineWidth: 2,
          verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
          pixelOffset: new Cesium.Cartesian2(0, -12),
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0.0, 5000.0)
        }
      });
      this.peakEntities.push(beaconEntity);
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

  /** Re-draw the wall (and, if shown, the peak spires) from the cached track. */
  _refreshTrack() {
    if (!this.currentAnalyzer || this.currentDrawPoints.length < 2) return;
    this.clearTrackEntities();
    this._render3DWallAndPath(this.currentAnalyzer, this.currentDrawPoints);
    if (this.showPeaks) {
      this.clearPeakEntities();
      this._renderPeakSpires(this.currentAnalyzer, this.currentPeaks);
    }
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
    if (visible && this.currentAnalyzer) {
      this._renderPeakSpires(this.currentAnalyzer, this.currentPeaks);
    }
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

  /**
   * Clear all entities
   */
  clearAll() {
    this.clearTrackEntities();
    this.clearPeakEntities();
    this.clearOsmBuildingEntities();
    this.clearRfEntities();
    if (this.scrubEntity) this.scrubEntity.show = false;
  }

  /**
   * Fly camera to encompass and perfectly center the entire active track
   */
  flyToTrack() {
    if (!this.viewer || this.currentDrawPoints.length === 0) return;

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
  }

  /**
   * Capture high-res screenshot of the 3D globe view (PNG)
   */
  exportSnapshot(filename = 'biomap_3d_snapshot.png') {
    if (!this.viewer) return;

    // Force single frame render before capturing canvas
    this.viewer.render();
    const canvas = this.viewer.scene.canvas;

    const link = document.createElement('a');
    link.download = filename;
    link.href = canvas.toDataURL('image/png');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  /**
   * Export track as CZML (Cesium 3D JSON format)
   */
  exportCzml(filename = 'biomap_track_3d.czml') {
    if (!this.currentAnalyzer || this.currentDrawPoints.length === 0) {
      this._notifyWarn('No active track loaded to export.');
      return;
    }

    const drawPoints = this.currentDrawPoints;
    const metric = this.activeColoringMetric;
    const series = this._getMetricSeries(this.currentAnalyzer, metric);

    const positions = [];
    const minHeights = [];
    const maxHeights = [];

    for (let i = 0; i < drawPoints.length; i++) {
      const pt = drawPoints[i];
      const val = Math.max(0, series[pt.origIdx] || 0);
      positions.push(pt.lon, pt.lat, 0);
      minHeights.push(0);
      maxHeights.push(this.baseHeight + val * this.extrusionScale);
    }

    const czml = [
      {
        id: 'document',
        name: 'BioMapping 3D Emotional Topography',
        version: '1.0'
      },
      {
        id: 'biomap_3d_ribbon',
        name: 'GSR Emotional Ribbon',
        wall: {
          positions: {
            cartographicDegrees: positions
          },
          minimumHeights: minHeights,
          maximumHeights: maxHeights,
          material: {
            solidColor: {
              color: {
                rgba: [0, 212, 255, 200]
              }
            }
          }
        }
      }
    ];

    const blob = new Blob([JSON.stringify(czml, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /**
   * Export track as 3D KML (with <extrude>1</extrude> for Google Earth)
   */
  exportKml(filename = 'biomap_track_3d.kml') {
    if (!this.currentAnalyzer || this.currentDrawPoints.length === 0) {
      this._notifyWarn('No active track loaded to export.');
      return;
    }

    const drawPoints = this.currentDrawPoints;
    const metric = this.activeColoringMetric;
    const series = this._getMetricSeries(this.currentAnalyzer, metric);

    let kmlCoords = '';
    for (let i = 0; i < drawPoints.length; i++) {
      const pt = drawPoints[i];
      const val = Math.max(0, series[pt.origIdx] || 0);
      const height = this.baseHeight + val * this.extrusionScale;
      kmlCoords += `${pt.lon},${pt.lat},${height.toFixed(1)}\n`;
    }

    const kmlContent = `<?xml version="1.0" encoding="UTF-8"?>
<kml xmlns="http://www.opengis.net/kml/2.2">
  <Document>
    <name>BioMapping 3D Emotional Landscape</name>
    <Style id="biomapWallStyle">
      <LineStyle>
        <color>ff00ffff</color>
        <width>3</width>
      </LineStyle>
      <PolyStyle>
        <color>aa00d4ff</color>
      </PolyStyle>
    </Style>
    <Placemark>
      <name>3D Arousal Ribbon</name>
      <styleUrl>#biomapWallStyle</styleUrl>
      <LineString>
        <extrude>1</extrude>
        <tessellate>1</tessellate>
        <altitudeMode>relativeToGround</altitudeMode>
        <coordinates>
${kmlCoords.trim()}
        </coordinates>
      </LineString>
    </Placemark>
  </Document>
</kml>`;

    const blob = new Blob([kmlContent], { type: 'application/vnd.google-earth.kml+xml' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.download = filename;
    link.href = url;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { GSRGlobeManager, BASEMAP_PROVIDERS, SERIES_FIELD, seriesValue };
}
if (typeof window !== 'undefined') {
  window.GSRGlobeManager = GSRGlobeManager;
}
