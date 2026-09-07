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
    const clusters = GSRSpatialClustering.compactClusters(peaks, P.mergeM, P.separationFactor);
    const places = GSRArousalPlaces.buildPlaces(
      clusters, scoreTracks,
      (typeof GSR_CONST !== 'undefined' ? GSR_CONST.AROUSAL_PLACES : {})
    );

    this._renderArousalPlaces(places, {
      collective: view.collective,
      activeTrackCount: view.activeTrackCount,
      refAmplitude: this._meanAmplitude(peaks),
      sigma: P.sigma,
      blobRadius: P.blobRadius,
      drawGapFactor: P.drawGapFactor
    });
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
   * @param {{collective:boolean, activeTrackCount:number, refAmplitude:number,
   *   sigma:number, blobRadius:number, drawGapFactor:number}} ctx
   * @private
   */
  _renderArousalPlaces(places, ctx) {
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
      GSRSpatialClustering.getConcaveBlob(place.cluster, ctx.sigma, ctx.blobRadius, ctx.refAmplitude)
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
