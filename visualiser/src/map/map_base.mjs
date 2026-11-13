// Leaflet.js Map Manager for GSR + GPS Visualisation
// Handles path rendering, arousal color-coding, and peak marker overlays.

import { GSR_CONST } from '../core/constants.mjs';
import { RFFluidRenderer } from '../render/rf_fluid_renderer.mjs';
import { GSRBasemap } from './basemap.mjs';
import { GSRMapMarkers } from './map_markers.mjs';
import {
  enableSmoothWheelZoom,
  SMOOTH_ZOOM_MAP_OPTIONS,
} from './smooth_wheel_zoom.mjs';

export class GSRMapBase {
  // Lifecycle stubs overridden by subclasses
  _initLegend() {}
  _refreshPathOnZoom() {}
  _declutterArousalPlaceBadges() {}

  constructor(mapContainerId) {
    this.containerId = mapContainerId;
    this.map = null;
    this.contourLayers = [];
    this.osmLayers = [];
    // Phase 1 (slice 3): legacy fallback for layers rendered without a managed
    // track (bare analyzer direct-add path); rendered tracks own their layers
    // in track._ownedLayers instead.
    this._unownedLayers = [];
    this.scrubMarker = null;
    this.showPeaks = true;
    this.showHotspots = true;
    this.showLabels = true;
    this.showClusters = true;
    this.showIsolines = true;
    this.showSurface = true;
    this.showTracks = true;
    this.showRFFluid = false;
    this.hasRfData = false;
    this.clusterLayers = [];
    this.activeColoringMetric = 'gsr';
    this._legendControl = null;
    this._legendMinVal = 0;
    this._legendMaxVal = 0;
    this._legendUniqueVals = null;

    // ── Render caches ──────────────────────────────────────────────────
    // GPS filter cache: trackId -> { paramsHash, snapFingerprint, gpsPoints, drawPoints }
    this._gpsCache = new Map();

    // Arousal Places cache: { fp, places, blobRings, refAmplitude } — lets a
    // GSR/GPS slider frame that doesn't change the clusterer's inputs skip
    // compactClusters()/buildPlaces()/getConcaveBlob() (see
    // _renderArousalPlacesFor). _lastArousalInput is the last (peaks,
    // scoreTracks, view) so refreshArousalPlaces() can replay it.
    this._arousalPlacesCache = null;
    this._lastArousalInput = null;

    // Phase 1 (slice 2): the set of track layerGroups THIS manager has rendered
    // (trackId -> track). Clearing iterates this set rather than re-reading
    // AppState.collectiveManager.tracks, so a track removed from the manager
    // can never leave an orphaned layerGroup behind (the collective-view drift
    // bug this slice fixes).
    this._renderedTrackGroups = new Map();

    // Remember what the viewport was last auto-fit to, so renderData/renderCollectiveData
    // can tell "a genuinely new track/track-set just became active" (re-fit is wanted) apart
    // from "the same track is being redrawn because a filter slider moved" (re-fit would yank
    // the user back out to full-extent zoom on every tweak — see _fitBounds callers below).
    this._lastFitBoundsTrackId = null;
    this._lastFitBoundsTrackSet = null;

    // Overlap-aware path colour (see PathOverlap.pooledAccessor). _refreshPathOnZoom
    // uses these to skip the path rebuild on a zoom that can't change the
    // overlap outcome: whether the last path can retrace itself at all, its
    // pooled-outcome fingerprint, and the inputs needed to recompute that
    // fingerprint cheaply at a new zoom.
    this._pathHasRetrace = false;
    this._lastPathZoom = null;
    this._lastPathOverlapSig = 0;
    this._lastPathTrackWeight = 5;
    this._lastPathGetVal = null;
    this._lastPathIsCategorical = false;

    if (mapContainerId) {
      this.initMap();
      this._initLegend();
    }
  }

  /**
   * Initialize Leaflet map with CartoDB Dark Matter tile layer
   */
  initMap() {
    // Default view zoomed out
    this.map = L.map(this.containerId, {
      zoomControl: false,
      ...SMOOTH_ZOOM_MAP_OPTIONS,
      preferCanvas: true,
      // Keeps canvas peak dots above the path and shapes (see map_markers).
      renderer: GSRMapMarkers.createMapRenderer(L),
      zoomDelta: 0.25,
      maxZoom: 22,
    }).setView([0, 0], 2);
    enableSmoothWheelZoom(this.map);

    if (this.map.attributionControl) {
      this.map.attributionControl.setPrefix(false);
    }

    // Light Map Style (OpenStreetMap base, CartoDB Positron)
    // Kept as this.baseTileLayer (not just addTo(this.map) and discarded) so
    // GSRMapExporter can force it to prefetch tiles beyond the live viewport
    // before an SVG export — see exportToSvg's isoband-canvas-expansion
    // handling and map_exporter.js's _ensureTileCoverage doc comment.
    // CARTO basemap URL + key resolution shared via GSRBasemap
    // (src/map/basemap.js); crossOrigin is added here for the SVG exporter's
    // tile prefetch — the live follow-map doesn't need it.
    this.baseTileLayer = L.tileLayer(GSRBasemap.cartoTileUrl('light_all'), {
      ...GSRBasemap.tileOptions(),
      crossOrigin: true,
    }).addTo(this.map);

    // Leaflet's default attribution prefix includes a 🇺🇦 flag alongside the
    // "Leaflet" credit link (added in v1.8.0). Keep the credit link, drop the
    // flag — same text Leaflet itself renders by default, minus the emoji.
    if (this.map.attributionControl) {
      this.map.attributionControl.setPrefix(false);
    }

    // Initialise scrubbing indicator marker (pulsing blue circle)
    const scrubIcon = L.divIcon({
      className: 'scrub-marker-icon',
      html: '<div class="scrub-dot"></div>',
      iconSize: [16, 16],
      iconAnchor: [8, 8],
    });
    // zIndexOffset keeps this above peak/hotspot/arousal-place markers, which
    // default to 0 and stack by latitude — without this the scrub dot could
    // end up hidden behind them depending on where it sits on the track.
    this.scrubMarker = L.marker([0, 0], {
      icon: scrubIcon,
      zIndexOffset: 10000,
    });

    // Initialise static RF Fluid background renderer layer
    this.rfFluidRenderer = new RFFluidRenderer(this.map, { visible: false });

    // Overlap-aware path colour depends on the on-screen stroke width, which
    // changes with zoom — re-run the path renderer once zooming has stopped
    // (see _schedulePathRefreshOnZoom / _refreshPathOnZoom).
    this.map.on('zoomstart', () => this._cancelPathRefreshOnZoom());
    this.map.on('zoomend', () => this._schedulePathRefreshOnZoom());

    // Arousal Place badges are screen-space — re-fold/unfold colliding ones once
    // the new zoom settles (see _declutterArousalPlaceBadges).
    this.map.on('zoomend', () => {
      try {
        this._declutterArousalPlaceBadges();
      } catch (_e) {
        /* a zoom must never break */
      }
    });
  }

  _getMetricKey(metric) {
    // OSM entries (roadClass..amenityCount) come from the shared
    // GSR_CONST.OSM_METRICS table (constants.js) — manager/legend.js's
    // metricNames is the other consumer of that same table.
    const keys = {
      gsr: 'val',
      hdopQuality: 'hdop',
      em_fog: 'em_fog',
      // Note: phasic/tonic/peakDensity/phasicAUC/arousalIndex are NOT looked
      // up via this key — see DERIVED_METRIC_SERIES in _renderPathSegments.
      // They live in per-sample analyzer arrays (analyzer.phasic[i], etc.),
      // not on the drawPoint objects themselves, and drawPoints are cached
      // across GSR re-analyses (keyed only on GPS params), so baking them in
      // here would go stale the moment a GSR slider changes without a GPS
      // param also changing.
    };
    GSR_CONST.OSM_METRICS.forEach((m) => {
      keys[m.key] = m.field;
    });
    if (GSR_CONST.SATELLITE_METRICS) {
      GSR_CONST.SATELLITE_METRICS.forEach((m) => {
        keys[m.key] = m.field;
      });
    }
    return keys[metric] || 'val';
  }
  // GSRMapManager is completed by prototype-augment files loaded immediately
  // after this one (see index.html / boot_app.js SCRIPT_ORDER):
  //   manager/process.js   — GPS pipeline → drawPoints + cache
  //   manager/legend.js    — the bottom-right legend
  //   manager/layers.js    — per-track layer ownership + clearMap/clearAll
  //   manager/osm.js       — OSM vector overlays
  //   manager/rf_fluid.js  — RF Fluid overlay control
  //   manager/viewport.js  — fit/zoom/scrub navigation
  //   manager/render.js    — renderData / refreshPath / refreshPeakMarkers
  //   manager/path.js      — colour-coded path segment rendering
  //   manager/peaks.js     — peak / hotspot marker rendering
  //   manager/arousal_places.js — the Arousal Places layer (cluster → ranked places)
  //   manager/collective.js— collective / multi-track view + contours
  //   manager/toggles.js   — layer visibility toggles
}
