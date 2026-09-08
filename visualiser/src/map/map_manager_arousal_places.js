/**
 * GSRMapManager — the Arousal Places map layer. Prototype-augment split from
 * map_manager_peaks.js: proximity clusters of arousal peaks become ranked,
 * clickable "place" records (dwell-normalised scoring in arousal_places.js),
 * each drawn as a clipped concave outline plus a numbered P1..Pn badge.
 *
 * _renderArousalPlacesFor() is the single entry point for both views:
 * _renderPeakMarkers() (map_manager_peaks.js) passes one track's active peaks,
 * renderCollectiveData() (map_manager_collective.js) passes every active
 * track's. It reads the params, clusters, scores, and hands off to
 * _renderArousalPlaces().
 *
 * Loaded after map_manager_peaks.js. Depends on the globals L, GeoUtils,
 * GSRSpatialClustering, GSRArousalPlaces, MapPopups, GSR_CONST and AppState,
 * all resolved at call time.
 */
Object.assign(GSRMapManager.prototype, {

  /**
   * Cluster a set of active (non-excluded) peaks into Arousal Places and render
   * them. Renders nothing when the clustering libs aren't loaded or `peaks` is
   * empty.
   *
   * The expensive part — compactClusters() + GSRArousalPlaces.buildPlaces()'s
   * O(places x raw samples) dwell/energy scan + one getConcaveBlob() KDE per
   * place — is memoised on `this._arousalPlacesCache`, keyed by a fingerprint of
   * every input it reads (active peak set, per-track raw/phasic identity, the
   * merge-distance params, view mode). renderData()/renderCollectiveData() re-run
   * this on every GSR/GPS slider frame; when nothing the clusterer sees has
   * changed (the common case — a GPS smoothing nudge, a non-arousal panel
   * toggle), the cache hit skips ~35 ms of the ~36 ms cost and only the cheap
   * Leaflet layer rebuild runs. Mirrors _getOrBuildDrawPoints()'s _gpsCache
   * pattern (map_manager_process.js).
   *
   * @param {Array<{lat,lon,amplitude,trackId,time}>} peaks
   * @param {Array<{id,sampleRate,raw,phasic}>} scoreTracks - Tracks buildPlaces()
   *   scans for dwell/energy: one entry single-track, N in collective.
   * @param {{collective:boolean, activeTrackCount:number}} view
   * @private
   */
  _renderArousalPlacesFor(peaks, scoreTracks, view) {
    if (!peaks || peaks.length === 0
        || typeof GSRSpatialClustering === 'undefined'
        || typeof GSRArousalPlaces === 'undefined') return;

    const P = this._arousalPlaceParams();

    // Remember the last input so refreshArousalPlaces() (the #placeMergeDistance
    // scoped refresh) can re-run without re-deriving peak coordinates — a merge
    // change touches P only, never `peaks`/`scoreTracks`.
    this._lastArousalInput = { peaks, scoreTracks, view };

    const fp = this._arousalPlacesFingerprint(peaks, scoreTracks, view, P);
    const cache = this._arousalPlacesCache;
    let places, blobRings, refAmplitude;
    if (cache && cache.fp === fp) {
      ({ places, blobRings, refAmplitude } = cache);
    } else {
      const clusters = GSRSpatialClustering.compactClusters(peaks, P.mergeM, P.separationFactor);
      places = GSRArousalPlaces.buildPlaces(
        clusters, scoreTracks,
        (typeof GSR_CONST !== 'undefined' ? GSR_CONST.AROUSAL_PLACES : {})
      );
      refAmplitude = this._meanAmplitude(peaks);
      blobRings = places.map(place =>
        GSRSpatialClustering.getConcaveBlob(place.cluster, P.sigma, P.blobRadius, refAmplitude)
      );
      this._arousalPlacesCache = { fp, places, blobRings, refAmplitude };
    }

    this._renderArousalPlaces(places, blobRings, {
      collective: view.collective,
      activeTrackCount: view.activeTrackCount,
      refAmplitude,
      drawGapFactor: P.drawGapFactor
    });
  },

  /**
   * Re-render ONLY the Arousal Places layer — the scoped refresh for the
   * "Place Merge Distance" slider (#placeMergeDistance), which reshapes places
   * but leaves the path, peak, hotspot and (collective) contour layers it never
   * touches. A full rerenderMap() rebuilt all of those for nothing (perf-routes
   * doc SS2.2); this strips just `this.clusterLayers` and replays
   * _renderArousalPlacesFor() with the last input, so the fingerprint misses
   * (P.mergeM changed) and the places recompute — but nothing else does.
   *
   * Falls back to GSRUI.rerenderMap() when there is no cached input yet (no
   * track rendered, or the last render produced no places).
   */
  refreshArousalPlaces() {
    if (!this.map || !this._lastArousalInput) {
      if (typeof GSRUI !== 'undefined' && typeof GSRUI.rerenderMap === 'function') GSRUI.rerenderMap();
      return;
    }
    this.clusterLayers = this._clearLayerGroup(this.clusterLayers);
    const { peaks, scoreTracks, view } = this._lastArousalInput;
    this._renderArousalPlacesFor(peaks, scoreTracks, view);
    if (typeof AppState !== 'undefined' && AppState.emit) AppState.emit('map:rendered');
  },

  /**
   * Fingerprint every input _renderArousalPlacesFor()'s memoised computation
   * reads, so the cache invalidates exactly when the rendered places would
   * differ and never when they wouldn't. Cheap: one rolling FNV-1a hash, an
   * O(peaks) fold plus a full O(phasic) fold per track (phasic drives
   * buildPlaces()'s energy term and analyze() refills it in a pooled buffer, so
   * reference identity can't be trusted — the values must be read).
   * @private
   */
  _arousalPlacesFingerprint(peaks, scoreTracks, view, P) {
    if (!this._apFpF64) {
      this._apFpF64 = new Float64Array(1);
      this._apFpU32 = new Uint32Array(this._apFpF64.buffer);
    }
    const f64 = this._apFpF64, u32 = this._apFpU32;
    let h = 0x811c9dc5 | 0;
    const mixF = (x) => {
      f64[0] = +x || 0;
      h = Math.imul(h ^ u32[0], 0x01000193);
      h = Math.imul(h ^ u32[1], 0x01000193);
    };
    const mixS = (s) => {
      s = s == null ? '' : String(s);
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
    };

    // Active peak set — the exact input to compactClusters()/buildPlaces().
    // Captures GPS filtering (peak coords move), re-detection and exclusion
    // (peaks is already the non-excluded set) in one O(peaks) pass.
    mixF(peaks.length);
    for (let i = 0; i < peaks.length; i++) {
      const pk = peaks[i];
      mixF(pk.lat); mixF(pk.lon); mixF(pk.amplitude); mixF(pk.time);
      if (typeof pk.trackId === 'number') mixF(pk.trackId); else mixS(pk.trackId);
    }

    // Per-track dwell/energy inputs. raw lat/lon are immutable after CSV load
    // (OSM enrichment only ADDS fields), so raw.length + an osm_road_class
    // sample is enough for the raw side; phasic is folded in full.
    for (let t = 0; t < scoreTracks.length; t++) {
      const trk = scoreTracks[t] || {};
      const raw = Array.isArray(trk.raw) ? trk.raw : [];
      const phasic = Array.isArray(trk.phasic) ? trk.phasic : [];
      mixS(trk.id);
      mixF(trk.sampleRate || 0);
      mixF(raw.length);
      const rn = raw.length;
      for (const k of [0, rn >> 1, rn - 1]) {
        const s = raw[k];
        mixS(s && s.osm_road_class != null ? String(s.osm_road_class) : '-');
      }
      mixF(phasic.length);
      for (let i = 0; i < phasic.length; i++) {
        const v = phasic[i];
        mixF(v && typeof v.val === 'number' ? v.val : 0);
      }
    }

    mixF(P.mergeM); mixF(P.separationFactor); mixF(P.sigma);
    mixF(P.blobRadius); mixF(P.drawGapFactor);
    mixF(view.collective ? 1 : 0);
    mixF(view.activeTrackCount || 0);

    return (h >>> 0).toString(36);
  },

  /**
   * Read the "Place Merge Distance" slider (#placeMergeDistance) plus the fixed
   * AROUSAL_PLACES constants. mergeM is the compactClusters() leader radius;
   * sigma / blobRadius only shape the cosmetic getConcaveBlob() outline, not the
   * place score (dwell-normalised energy, computed in arousal_places.js).
   * @private
   */
  _arousalPlaceParams() {
    const C = (typeof GSR_CONST !== 'undefined' && GSR_CONST.AROUSAL_PLACES) ? GSR_CONST.AROUSAL_PLACES : {};
    const fallback = C.mergeM || 35;
    let mergeM = AppState.sliders.placeMergeDistance
      ? parseFloat(AppState.sliders.placeMergeDistance.value)
      : fallback;
    if (isNaN(mergeM)) mergeM = fallback;
    return {
      mergeM,
      sigma: mergeM * 0.35,
      blobRadius: mergeM * 0.5,
      separationFactor: C.seedSeparationFactor || 1.8,
      drawGapFactor: C.drawGapFactor || 0.46
    };
  },

  /** Mean amplitude across {amplitude} peak objects — the getConcaveBlob() severity reference. @private */
  _meanAmplitude(pts) {
    if (!pts || pts.length === 0) return 0;
    let sum = 0;
    for (const p of pts) sum += (p.amplitude || 0);
    return sum / pts.length;
  },

  /**
   * Render the ranked place records from GSRArousalPlaces.buildPlaces(): per
   * place, a clipped concave outline (cosmetic) plus a numbered P1..Pn badge at
   * the centroid, both opening MapPopups.buildArousalPlacePopup() on click.
   *
   * No two places may visually overlap: compactClusters()'s seed separation
   * spaces the centroids, and each outline is scaled toward its own centroid so
   * its farthest vertex stays within drawGapFactor (<= 0.5) of the nearest other
   * place. Badges are screen-space, so _declutterArousalPlaceBadges() folds any
   * that would still collide into the top-ranked one with a "+N" count.
   *
   * Layers go on this.clusterLayers (shared with the globe3d handoff and the
   * clear paths) and honour this.showClusters.
   *
   * @param {Array<object>} places - Ranked place records, best-first.
   * @param {Array<Array<Array<{lat,lon}>>>} blobRings - Per-place getConcaveBlob()
   *   output (array of closed rings), parallel to `places`. Precomputed and
   *   memoised by _renderArousalPlacesFor() so a cache hit skips the KDE passes.
   * @param {{collective:boolean, activeTrackCount:number, refAmplitude:number,
   *   drawGapFactor:number}} ctx
   * @private
   */
  _renderArousalPlaces(places, blobRings, ctx) {
    this._arousalPlaceBadges = [];
    if (!Array.isArray(places) || places.length === 0) return;

    const rates = places.map(p => p.rate).filter(r => isFinite(r));
    const rateMin = rates.length ? Math.min(...rates) : 0;
    const rateMax = rates.length ? Math.max(...rates) : 1;
    const lastIdx = Math.max(1, places.length - 1);
    const gapFactor = ctx.drawGapFactor || 0.46;

    places.forEach((place, i) => {
      const style = this._placeStyle(place, ctx, rateMin, rateMax);

      // The badge encodes RANK (P1 = biggest/darkest) — a channel separate from
      // the outline (inter-track agreement in collective, rate in single).
      const rankRatio = 1 - i / lastIdx;               // 1 at P1 -> 0 at Pn
      const desc = {
        lat: place.lat, lon: place.lon, label: place.label,
        px: Math.round(18 + rankRatio * 12),           // 18..30 px
        color: `hsl(${18 - rankRatio * 18}, ${55 + rankRatio * 35}%, ${58 - rankRatio * 22}%)`,
        fontRem: (0.6 + rankRatio * 0.18).toFixed(2),
        tooltip: style.tooltip
      };

      const capM = this._nearestPlaceGap(places, i) * gapFactor;
      ((blobRings && blobRings[i]) || [])
        .forEach(path => {
          const clipped = this._clipRingToRadius(path, place.lat, place.lon, capM);
          const poly = L.polygon(clipped.map(p => [p.lat, p.lon]), {
            color: style.color, weight: style.weight,
            fillColor: style.color, fillOpacity: style.fillOpacity,
            dashArray: style.dashArray, lineCap: 'round', lineJoin: 'round'
          });
          poly.bindTooltip(style.tooltip, { sticky: true, className: 'contour-tooltip-label' });
          poly.bindPopup(() => MapPopups.buildArousalPlacePopup(place, ctx));
          poly._gsrKind = 'arousalPlace';
          if (this.showClusters) poly.addTo(this.map);
          this.clusterLayers.push(poly);
        });

      const badge = L.marker([place.lat, place.lon], { icon: this._arousalBadgeIcon(desc) });
      badge.setZIndexOffset(1200 + Math.round(rankRatio * 100));
      badge.bindTooltip(style.tooltip, { sticky: true, className: 'contour-tooltip-label' });
      badge.bindPopup(() => MapPopups.buildArousalPlacePopup(place, ctx));
      badge._gsrKind = 'arousalPlace';
      if (this.showClusters) badge.addTo(this.map);
      this.clusterLayers.push(badge);

      desc.marker = badge;
      this._arousalPlaceBadges.push(desc);
    });

    this._declutterArousalPlaceBadges();
  },

  /** The divIcon for one Arousal Place badge; `extra` > 0 renders a "+N" merge count. @private */
  _arousalBadgeIcon({ px, color, fontRem, label }, extra = 0) {
    return L.divIcon({
      className: 'arousal-place-badge-wrap',
      html: `<span class="arousal-place-badge${extra ? ' merged' : ''}" `
          + `style="--place-color:${color};width:${px}px;height:${px}px;font-size:${fontRem}rem">`
          + `${label}${extra ? `<sup>+${extra}</sup>` : ''}</span>`,
      iconSize: [px, px],
      iconAnchor: [px / 2, px / 2]
    });
  },

  /**
   * Outline style for one Arousal Place (the badge is styled separately by rank).
   * Collective view (2+ active tracks): the amber→red ramp is inter-track
   * *agreement* (trackCount / activeTrackCount); a one-walker place renders faint
   * and dashed ("provisional"). Single-track (or a lone collective track): the
   * ramp is the dwell-normalised `rate`, min→max-normalised across this render.
   * @private
   */
  _placeStyle(place, ctx, rateMin, rateMax) {
    const multiTrack = ctx.collective && ctx.activeTrackCount > 1;
    let ratio;
    if (multiTrack) {
      ratio = Math.max(0, Math.min(1, place.trackCount / ctx.activeTrackCount));
    } else {
      const span = rateMax - rateMin;
      ratio = span > 1e-9 ? Math.max(0, Math.min(1, (place.rate - rateMin) / span)) : 0.5;
    }

    const provisional = multiTrack && place.provisional;
    const color = `hsl(${40 - ratio * 40}, ${75 + ratio * 20}%, ${58 - ratio * 15}%)`; // amber -> red
    const fillOpacity = provisional ? 0.05 : 0.10 + ratio * 0.35;
    const weight = provisional ? 1 : 1.5 + ratio * 2.5;
    const dashArray = provisional ? '2, 6' : '4, 6';

    const responses = `${place.memberCount} ${place.memberCount === 1 ? 'response' : 'responses'}`;
    const walks = multiTrack ? ` · ${place.trackCount}/${ctx.activeTrackCount} walks` : '';
    const prov = provisional ? ' · provisional' : '';
    const tooltip = `${place.label}${walks} · ${responses} · ${place.rate.toFixed(2)} µS·s/min${prov}`;

    return { color, fillOpacity, weight, dashArray, tooltip, ratio };
  },

  /**
   * Metres from place `i` to its nearest neighbour. The outline of `i` is later
   * scaled to stay within gapFactor (<= 0.5) of this, so cap(i) + cap(j) <
   * dist(i, j) for every pair and no two outlines can cross. O(n^2) over the
   * <= maxPlaces records. Infinity when there is nothing to clip against.
   * @private
   */
  _nearestPlaceGap(places, i) {
    if (places.length < 2 || typeof GeoUtils === 'undefined') return Infinity;
    const scale = GeoUtils.getGeodesicScale(places[i].lat);
    let nnSq = Infinity;
    for (let j = 0; j < places.length; j++) {
      if (j === i) continue;
      const d = GeoUtils.distanceMetersSq(places[i].lat, places[i].lon, places[j].lat, places[j].lon, scale);
      if (d < nnSq) nnSq = d;
    }
    return Math.sqrt(nnSq);
  },

  /**
   * Uniformly scale a lat/lon ring toward (cLat, cLon) so its farthest vertex
   * sits within `capM` metres — keeps the blob shape, just shrinks it when a
   * neighbour is close. Returned untouched when it already fits.
   * @private
   */
  _clipRingToRadius(path, cLat, cLon, capM) {
    if (!(capM > 0) || !isFinite(capM) || !Array.isArray(path) || path.length === 0
        || typeof GeoUtils === 'undefined') return path;
    const scale = GeoUtils.getGeodesicScale(cLat);
    let maxSq = 0;
    for (const p of path) {
      const d = GeoUtils.distanceMetersSq(cLat, cLon, p.lat, p.lon, scale);
      if (d > maxSq) maxSq = d;
    }
    const k = capM / Math.sqrt(maxSq);
    if (!(k < 1)) return path;
    return path.map(p => ({ lat: cLat + (p.lat - cLat) * k, lon: cLon + (p.lon - cLon) * k }));
  },

  /**
   * Fold Arousal Place badges that would visually collide at the current zoom
   * into the top-ranked badge of each colliding group, which then shows a "+N"
   * count and lists the folded places in its tooltip. Re-run on zoomend (map.js)
   * and when the layer is toggled back on, so badges separate again on zoom-in.
   * Screen-space presentation only — the outlines and clusterLayers are untouched.
   * @private
   */
  _declutterArousalPlaceBadges() {
    const badges = this._arousalPlaceBadges;
    if (!badges || !badges.length || !this.map || !this.showClusters
        || typeof this.map.latLngToContainerPoint !== 'function') return;

    let pts;
    try { pts = badges.map(b => this.map.latLngToContainerPoint([b.lat, b.lon])); }
    catch (e) { return; }

    // Best-rank-first (badges are already P1..Pn): each badge either survives or
    // folds into the first earlier survivor whose icon it would touch.
    const survivors = []; // { i, folded: [label, ...] }
    badges.forEach((b, i) => {
      const host = survivors.find(s => {
        const need = (b.px + badges[s.i].px) / 2 + 2;
        const dx = pts[i].x - pts[s.i].x, dy = pts[i].y - pts[s.i].y;
        return dx * dx + dy * dy < need * need;
      });
      if (host) host.folded.push(b.label);
      else survivors.push({ i, folded: [] });
      this._toggleLayer(b.marker, !host);
    });

    for (const { i, folded } of survivors) {
      const b = badges[i];
      b.marker.setIcon(this._arousalBadgeIcon(b, folded.length));
      b.marker.setTooltipContent(folded.length
        ? `${[b.label, ...folded].join(', ')} · ${folded.length + 1} places here — zoom in to separate`
        : b.tooltip);
    }
  }

});
