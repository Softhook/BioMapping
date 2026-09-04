/**
 * GSRMapManager — OSM vector geometry overlays (parks, water, buildings).
 * Prototype-augment split from map.js: loaded immediately after map.js, adds
 * these methods to GSRMapManager.prototype.
 *
 * `drawOsmShapes(geoms)` groups same-style features into at most three
 * multi-ring L.polygon layers (park / water / building) and tracks them in
 * this.osmLayers; `clearOsmShapes()` removes them. It also feeds the current
 * draw points + geoms to this.rfFluidRenderer.
 *
 * Depends on the globals L and AppState (resolved at call time) and on
 * this._getOrBuildDrawPoints (map_manager_process.js).
 */
Object.assign(GSRMapManager.prototype, {

  /**
   * Draw OSM vector geometry overlays (parks, water, buildings) on the map.
   * Accepts pre-built geoms (from analyzer.osmGeoms) to avoid redundant
   * geometry reconstruction.
   */
  drawOsmShapes(geoms) {
    this.clearOsmShapes();
    if (!geoms || !geoms.ways || !this.map) return;

    let points = this._lastDrawPoints || [];
    if ((!points || points.length === 0) && typeof AppState !== 'undefined' && AppState.viewMode === 'collective' && AppState.collectiveManager) {
      const activeTracks = AppState.collectiveManager.getActiveTracks();
      const combinedPoints = [];
      activeTracks.forEach(t => {
        const p = t.gpsFilterParams || {};
        const { drawPoints } = this._getOrBuildDrawPoints(t.id, t.analyzer, p);
        if (drawPoints) combinedPoints.push(...drawPoints);
      });
      if (combinedPoints.length > 0) {
        points = combinedPoints;
        this._lastDrawPoints = combinedPoints;
      }
    }

    if (this.rfFluidRenderer) {
      this.rfFluidRenderer.setData(points, geoms);
    }

    this.osmLayers = [];

    // Group same-style shapes into a single ring array per category, instead
    // of one Leaflet Path layer per feature. Areas with dense OSM building
    // coverage can hand back thousands of ways/relations; each one used to
    // become its own L.polygon (own layer registration, own onAdd/_project
    // pass, own entry in the map's layer table). Rings within a category
    // never overlap each other (they're distinct real-world buildings/parks/
    // water bodies), so a single multi-ring L.polygon per category renders
    // pixel-identical output — canvas/SVG fill and stroke both treat each
    // disjoint ring independently regardless of winding — while cutting the
    // layer count from N features down to at most 3 (park/water/building).
    const ringsByCategory = { park: [], water: [], building: [] };
    const STYLES = {
      park:     { color: '#2d6a4f', fillColor: '#52b788', fillOpacity: 0.15, weight: 1 },
      water:    { color: '#0077b6', fillColor: '#90e0ef', fillOpacity: 0.25, weight: 1 },
      building: { color: '#4a4e69', fillColor: '#9a8c98', fillOpacity: 0.1,  weight: 1 }
    };

    geoms.ways.concat(geoms.relations).forEach(geom => {
      const tags = geom.tags;
      if (!tags) return;

      // Same green / water classification the enrichment metrics use, so the
      // drawn overlay can never disagree with green_pct / in_park / dist_water.
      // A wetland satisfies both predicates (blue AND green); the overlay can
      // only paint one colour, and green wins here.
      const isPark = OSMEnricher.isGreenSpace(geom);
      const isWater = OSMEnricher.isWaterSpace(geom);
      const isBuilding = !!tags.building;

      const category = isPark ? 'park' : (isWater ? 'water' : (isBuilding ? 'building' : null));
      if (!category) return;

      const rings = ringsByCategory[category];
      if (geom.type === 'way' && geom.coordinates.length > 2) {
        rings.push(geom.coordinates.map(pt => [pt.lat, pt.lon]));
      } else if (geom.type === 'relation' && geom.outerWays) {
        geom.outerWays.forEach(way => {
          rings.push(way.coordinates.map(pt => [pt.lat, pt.lon]));
        });
      }
    });

    for (const category of Object.keys(ringsByCategory)) {
      const rings = ringsByCategory[category];
      if (rings.length === 0) continue;
      const poly = L.polygon(rings, STYLES[category]).addTo(this.map);
      this.osmLayers.push(poly);
    }
  },

  clearOsmShapes() {
    if (this.osmLayers) {
      this.osmLayers.forEach(layer => this.map.removeLayer(layer));
    }
    this.osmLayers = [];
  },

  /**
   * Show streaming Sentinel-2 / satellite NDVI tile layer.
   * @param {string} [urlTemplate] - XYZ or WMS tile URL template
   * @param {Object} [options={}] - Layer options (opacity, maxZoom, etc.)
   */
  showNdviLayer(urlTemplate, options = {}) {
    if (!this.map) return;
    this.hideNdviLayer();

    const hasSampler = (typeof NDVISampler !== 'undefined');
    const activeProvider = hasSampler ? NDVISampler.getActiveProvider(options) : null;

    const instanceId = options.instanceId 
      || (hasSampler ? NDVISampler.getInstanceId() : (typeof localStorage !== 'undefined' && typeof localStorage.getItem === 'function' ? (localStorage.getItem('copernicus_instance_id') || '').trim() : ''));
    const layerId = options.layerId 
      || (hasSampler ? NDVISampler.getLayerId() : 'VEGETATION_INDEX');
    const timeRange = options.time 
      || (hasSampler ? NDVISampler.getTimeRange() : '2024-05-01/2024-09-30');
    const maxcc = (typeof options.maxcc === 'number') ? options.maxcc : 50;

    const url = urlTemplate || (hasSampler ? (activeProvider?.urlTemplate || NDVISampler.DEFAULT_TILE_URL) : 'https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2021_3857/default/GoogleMapsCompatible/{z}/{y}/{x}.jpg');
    const opacity = typeof options.opacity === 'number' ? options.opacity : 0.65;
    const isThematic = options.mode !== 'satellite';

    // Ensure dedicated pane exists with zIndex 250 (between base map and vector layers)
    if (!this.map.getPane('ndviPane')) {
      const pane = this.map.createPane('ndviPane');
      pane.style.zIndex = 250;
      pane.style.pointerEvents = 'none';
    }

    // 1. Direct Copernicus Sentinel-2 Band 8 NIR WMS tile stream (when configured)
    if (!urlTemplate && instanceId && typeof L !== 'undefined' && typeof L.tileLayer.wms === 'function') {
      const wmsBase = (hasSampler && NDVISampler.COPERNICUS_BASE_URL)
        ? NDVISampler.COPERNICUS_BASE_URL
        : 'https://sh.dataspace.copernicus.eu/ogc/wms';

      this.ndviTileLayer = L.tileLayer.wms(`${wmsBase}/${instanceId}`, {
        pane: 'ndviPane',
        layers: layerId,
        format: 'image/png',
        transparent: true,
        version: '1.3.0',
        maxZoom: 19,
        opacity: opacity,
        time: timeRange,
        maxcc: maxcc,
        attribution: 'Sentinel-2 Band 8 (NIR) NDVI © Copernicus / ESA',
        crossOrigin: 'Anonymous'
      }).addTo(this.map);
      return;
    }

    const layerOpts = {
      pane: 'ndviPane',
      opacity: opacity,
      maxZoom: 19,
      maxNativeZoom: 16,
      attribution: isThematic
        ? (activeProvider?.thematicAttribution || 'Vegetation Index (NDVI) © <a href="https://s2maps.eu" target="_blank">Sentinel-2 / EOX</a>')
        : (activeProvider?.attribution || 'NDVI & Imagery © <a href="https://s2maps.eu" target="_blank">Sentinel-2 cloudless / EOX</a>'),
      crossOrigin: 'Anonymous'
    };

    if (isThematic && typeof L !== 'undefined' && L.TileLayer && typeof L.TileLayer.extend === 'function' && typeof document !== 'undefined' && typeof document.createElement === 'function') {
      try {
        const ThematicNdviLayer = L.TileLayer.extend({
          createTile: function(coords, done) {
            const tile = document.createElement('canvas');
            tile.width = 256;
            tile.height = 256;
            const ctx = tile.getContext('2d');
            const tileUrl = this.getTileUrl(coords);

            const processImage = (imgSource) => {
              try {
                ctx.drawImage(imgSource, 0, 0);
                const imgData = ctx.getImageData(0, 0, 256, 256);
                if (hasSampler && typeof NDVISampler.shadeImageData === 'function') {
                  NDVISampler.shadeImageData(imgData);
                }
                ctx.putImageData(imgData, 0, 0);
                done(null, tile);
              } catch (e) {
                done(null, imgSource);
              }
            };

            // Check NDVISampler tile cache for instant reuse
            if (hasSampler) {
              const cached = NDVISampler._getTileCache(tileUrl);
              if (cached) {
                processImage(cached);
                return tile;
              }
            }

            const img = new Image();
            img.crossOrigin = 'Anonymous';
            img.onload = () => {
              if (hasSampler) {
                NDVISampler._putTileCache(tileUrl, img);
              }
              processImage(img);
            };
            img.onerror = (err) => done(err, tile);
            img.src = tileUrl;
            return tile;
          }
        });
        this.ndviTileLayer = new ThematicNdviLayer(url, layerOpts).addTo(this.map);
        // Free GPU canvas memory when tiles are pruned by Leaflet
        this.ndviTileLayer.on('tileunload', (e) => {
          if (e && e.tile && e.tile.tagName === 'CANVAS') {
            e.tile.width = 0;
            e.tile.height = 0;
          }
        });
        return;
      } catch (e) {
        // Fall back to standard tile layer below
      }
    }

    this.ndviTileLayer = L.tileLayer(url, layerOpts).addTo(this.map);
  },

  /**
   * Remove NDVI tile layer from map.
   */
  hideNdviLayer() {
    if (this.ndviTileLayer && this.map) {
      this.map.removeLayer(this.ndviTileLayer);
    }
    this.ndviTileLayer = null;
  },

  /**
   * Adjust NDVI tile layer opacity.
   * @param {number} opacity - 0.0 to 1.0
   */
  setNdviOpacity(opacity) {
    if (this.ndviTileLayer) {
      this.ndviTileLayer.setOpacity(opacity);
    }
  },

  /**
   * Toggle NDVI tile layer on or off.
   * @param {boolean} [show] - Explicit state, or toggles if undefined
   * @param {Object} [options={}]
   */
  toggleNdviLayer(show, options = {}) {
    const shouldShow = (show !== undefined) ? show : !this.ndviTileLayer;
    if (shouldShow) {
      this.showNdviLayer(options.urlTemplate, options);
    } else {
      this.hideNdviLayer();
    }
    return shouldShow;
  }

});
