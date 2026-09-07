/**
 * GSRMapManager — peak / hotspot / cluster marker rendering. Prototype-augment
 * split from map.js: loaded immediately after map.js, adds these methods to
 * GSRMapManager.prototype (and the two shared icon builders to GSRMapManager
 * itself as statics).
 *
 * Covers the single-track peak dots + labels + latency connectors
 * (_renderPeakMarkers), the memorable-event hotspot stars
 * (_renderHotspotMarkers / _createHotspotMarker), the Stress Places layer
 * (_renderStressPlaces + _getClusteringParams / _meanAmplitude / _placeStyle,
 * scoring in stress_places.js), and the collective/multi-track counterparts
 * (_renderCollectiveTrackPeaks / _renderCollectiveTrackHotspots /
 * refreshCollectivePeakMarkers). renderCollectiveData() (still in map.js) drives
 * the collective ones and the shared Stress Places pass through the prototype.
 *
 * Cartographic label placement + HTML builders live in GSRLabelManager
 * (label_placement.js); peak-popup DOM builders in MapPopups (map_popups.js).
 * Also depends on the globals L, GSRUI, GSRSpatialClustering and AppState
 * (resolved at call time).
 */
Object.assign(GSRMapManager.prototype, {

  _renderPeakMarkers(analyzer, data, peakLatency, track, options) {
    options = options || {};
    const layerGroup = track ? track.layerGroup : null;
    const map = this.map;
    const labelCandidates = [];
    const allPeaks = [];

    // First pass: collect pixel positions
    analyzer.peaks.forEach((peak, index) => {
      // Original (unshifted) position — used for connector line
      const origCoords = analyzer.getCoordinates(peak.index);
      const origPt = origCoords ? map.latLngToLayerPoint([origCoords.lat, origCoords.lon]) : null;

      // Apply latency: find GPS position at (peak time - latency)
      const si = this._resolveLatencyIndex(analyzer, peak, peakLatency);
      const coords = analyzer.getCoordinates(si);
      if (!coords) return;
      const pt = map.latLngToLayerPoint([coords.lat, coords.lon]);
      const origLatLon = origCoords ? [origCoords.lat, origCoords.lon] : null;
      allPeaks.push({ peak, index, coords, px: pt.x, py: pt.y, origPt, origLatLon });
      if (peak.label && peak.label.trim()) {
        labelCandidates.push({ idx: index, px: pt.x, py: pt.y, text: peak.label });
      }
    });

    // Compute 360° label positions
    const labelPositions = GSRLabelManager.computeLabelPositions(labelCandidates);

    // Compact dot-only icon for peaks without labels. Minor styling to match
    // the graph's resting-state peak dots: small, no pulse animation — the
    // full peak census can run into the hundreds/thousands, so a subdued
    // marker keeps hotspots (see _renderHotspotMarkers) as the visually
    // dominant layer, mirroring the graph's peaks-vs-hotspots hierarchy.
    const simpleIcon = GSRMapManager._buildPeakIcon();

    allPeaks.forEach(({ peak, index, coords, px, py }) => {
      const displayLabel = peak.label || '';

      let marker;
      const hasLabel = displayLabel && displayLabel.trim();
      if (hasLabel) {
        const dirResult = labelPositions.get(index);
        if (dirResult) {
          marker = L.marker([coords.lat, coords.lon], {
            icon: GSRLabelManager.buildLabelledIcon(px, py, displayLabel, dirResult, { showGlow: false, dotPx: 6 })
          });
          // Bump labelled markers above unlabelled markers and path layers
          marker.setZIndexOffset(1000);
          marker.hasLabel = true;
        } else {
          // All 8 positions overlapped — fall back to dot-only
          marker = L.marker([coords.lat, coords.lon], { icon: simpleIcon });
          marker.hasLabel = false;
        }
      } else {
        marker = L.marker([coords.lat, coords.lon], { icon: simpleIcon });
        marker.hasLabel = false;
      }

      // Phase 1 (slice 3): tag the peak index so focusOnPeak can resolve the
      // marker without the old flat array.
      marker._gsrPeakIndex = index;

      // Phase 1 (slice 1/3): the marker belongs to the track's layerGroup
      // REGARDLESS of whether it's currently visible. Tagging it only inside
      // the `shouldAdd` gate left hidden-at-render markers untagged, so
      // toggling them on later fell back to the legacy direct-to-map path and
      // they escaped the group — surviving track removal (removal only takes
      // the group). Tag always; add to the group only when visible.
      //
      // _gsrKind must be set unconditionally (not just in the layerGroup
      // branch) — getRenderLayers()/getPeakMarkerByIndex()/
      // updateMarkerVisibility() all classify layers by _gsrKind, including
      // ones rendered via the legacy no-track fallback below. Leaving it
      // unset there made fallback-rendered peaks invisible to all three
      // (found via refreshPeakMarkers()'s fallback-path test — see
      // _createHotspotMarker for the pattern this now matches).
      marker._gsrKind = 'peak';
      const shouldAdd = this.showPeaks || (this.showLabels && marker.hasLabel);
      if (layerGroup) {
        marker._gsrLayerGroup = layerGroup;
        if (shouldAdd) {
          layerGroup.addLayer(marker);
        }
      } else if (shouldAdd) {
        marker.addTo(this.map);
      }

      // Dim excluded peak markers
      if (peak.excluded) {
        marker.setOpacity(0.35);
      }

      marker.bindPopup(() => MapPopups.buildSinglePeakPopup(analyzer, peak, index, coords, marker));

      marker.on('click', () => {
        GSRUI.focusOnPeak(index, 'map');
      });

      this._registerTrackLayer(track, marker);
    });

    // Draw connector lines from original (unshifted) to shifted position
    if (peakLatency > 0) {
      for (const ap of allPeaks) {
        if (!ap.origLatLon) continue;
        const shiftedLatLon = [ap.coords.lat, ap.coords.lon];
        const conn = L.polyline([ap.origLatLon, shiftedLatLon], {
          color: '#f43f5e',
          weight: 1.5,
          opacity: 0.35,
          dashArray: '3, 5'
        });
        // Same unconditional-_gsrKind fix as the peak marker above.
        conn._gsrKind = 'connector';
        if (layerGroup) {
          conn._gsrLayerGroup = layerGroup;
          layerGroup.addLayer(conn);
        } else {
          conn.addTo(this.map);
        }
        this._registerTrackLayer(track, conn);
      }
    }

    // Render cluster boundaries. Skipped when options.skipClustering is set
    // (refreshPeakMarkers()'s label-edit path — see its own doc comment):
    // clusterPeaks() only reads lat/lon/amplitude per active peak, none of
    // which a label edit touches, so recomputing here is provably wasted —
    // found via real A/B benchmarking (docs/archive/visualizer_rendering_perf_routes.md
    // §2.4), where this was ~33ms of a ~36ms single-track refresh, the
    // reason that refresh was only ~1.1x faster than a full renderData()
    // despite skipping path/hotspot rebuilding entirely. An exclusion toggle
    // DOES change this method's input (activePeaks filters on ap.peak.excluded),
    // so it must keep recomputing — refreshPeakMarkers() only passes
    // skipClustering for the label-edit call site, not the exclusion one.
    if (!options.skipClustering) {
      const activePeaks = allPeaks.filter(ap => !ap.peak.excluded);
      if (activePeaks.length > 0 && typeof GSRSpatialClustering !== 'undefined' && typeof GSRStressPlaces !== 'undefined') {
        const trackId = track ? track.id : 'single';
        const ptsForClustering = activePeaks.map(ap => ({
          lat: ap.coords.lat,
          lon: ap.coords.lon,
          amplitude: ap.peak.amplitude,
          trackId,
          time: ap.peak.time,
          sampleIndex: ap.peak.index
        }));

        const { mergeM, sigma, blobRadius } = this._getClusteringParams();

        // Reference amplitude only feeds the cosmetic concave-outline weighting
        // in getConcaveBlob(); the place score itself is dwell-normalised energy.
        const refAmplitude = this._meanAmplitude(ptsForClustering);

        // Compact (non-chaining) grouping — see compactClusters() for why
        // single-linkage was wrong here.
        const clusters = GSRSpatialClustering.compactClusters(ptsForClustering, mergeM);
        const places = GSRStressPlaces.buildPlaces(
          clusters,
          [{ id: trackId, sampleRate: analyzer.sampleRate, raw: analyzer.raw, phasic: analyzer.phasic }],
          (typeof GSR_CONST !== 'undefined' ? GSR_CONST.STRESS_PLACES : {})
        );

        this._renderStressPlaces(places, {
          collective: false, activeTrackCount: 1, refAmplitude, sigma, blobRadius
        });
      }
    }
  },

  /**
   * Render the Stress Places layer: for each ranked place record from
   * GSRStressPlaces.buildPlaces(), a thin concave outline (cosmetic selection
   * affordance) plus a numbered P1..Pn badge at the centroid. Both carry the
   * same tooltip and open MapPopups.buildStressPlacePopup() on click.
   *
   * Everything is pushed to this.clusterLayers (not a new array) so the
   * globe3d handoff (globe3d_view.js reads mm.clusterLayers) and the existing
   * clear paths (map_manager_render.js, clearMap/clearCollectiveLayers) both
   * keep covering it. Honours this.showClusters exactly as the old blob layer.
   *
   * @param {Array<object>} places - Ranked place records.
   * @param {{collective:boolean, activeTrackCount:number, refAmplitude:number,
   *   sigma:number, blobRadius:number}} ctx - Render context.
   * @private
   */
  _renderStressPlaces(places, ctx) {
    if (!Array.isArray(places) || places.length === 0) return;

    const rates = places.map(p => p.rate).filter(r => isFinite(r));
    const rateMin = rates.length ? Math.min(...rates) : 0;
    const rateMax = rates.length ? Math.max(...rates) : 1;
    const lastIdx = Math.max(1, places.length - 1);

    places.forEach((place, i) => {
      const style = this._placeStyle(place, ctx, rateMin, rateMax);

      // The badge encodes RANK (P1 = biggest/darkest) — a channel separate from
      // the outline, which encodes inter-track agreement (collective) or rate
      // (single). places is already sorted best-first.
      const rankRatio = 1 - i / lastIdx;               // 1 at P1 -> 0 at Pn
      const badgePx = Math.round(18 + rankRatio * 12); // 18..30 px
      const badgeColor = `hsl(${18 - rankRatio * 18}, ${55 + rankRatio * 35}%, ${58 - rankRatio * 22}%)`;
      const badgeFontRem = (0.6 + rankRatio * 0.18).toFixed(2);

      const paths = GSRSpatialClustering.getConcaveBlob(
        place.cluster, ctx.sigma, ctx.blobRadius, ctx.refAmplitude
      );
      paths.forEach(path => {
        const latlngs = path.map(p => [p.lat, p.lon]);
        const poly = L.polygon(latlngs, {
          color: style.color,
          weight: style.weight,
          fillColor: style.color,
          fillOpacity: style.fillOpacity,
          dashArray: style.dashArray,
          lineCap: 'round',
          lineJoin: 'round'
        });
        poly.bindTooltip(style.tooltip, { sticky: true, className: 'contour-tooltip-label' });
        poly.bindPopup(() => MapPopups.buildStressPlacePopup(place, ctx));
        poly._gsrKind = 'stressPlace';
        if (this.showClusters) poly.addTo(this.map);
        this.clusterLayers.push(poly);
      });

      const badge = L.marker([place.lat, place.lon], {
        icon: L.divIcon({
          className: 'stress-place-badge-wrap',
          html: `<span class="stress-place-badge" style="--place-color:${badgeColor};width:${badgePx}px;height:${badgePx}px;font-size:${badgeFontRem}rem">${place.label}</span>`,
          iconSize: [badgePx, badgePx],
          iconAnchor: [badgePx / 2, badgePx / 2]
        })
      });
      badge.setZIndexOffset(1200 + Math.round(rankRatio * 100));
      badge.bindTooltip(style.tooltip, { sticky: true, className: 'contour-tooltip-label' });
      badge.bindPopup(() => MapPopups.buildStressPlacePopup(place, ctx));
      badge._gsrKind = 'stressPlace';
      if (this.showClusters) badge.addTo(this.map);
      this.clusterLayers.push(badge);
    });
  },

  /**
   * Internal helper to construct and initialise a Leaflet hotspot marker.
   * @private
   */
  _createHotspotMarker(analyzer, peak, peakLatency, popupCallback, clickCallback, track) {
    const index = analyzer.peaks.indexOf(peak);
    if (index < 0) return null;

    const coords = this._hotspotMarkerCoords(analyzer, peak, peakLatency);
    if (!coords) return null;

    const layerGroup = track ? track.layerGroup : null;
    const hotspotIcon = GSRMapManager._buildHotspotIcon();
    const marker = L.marker([coords.lat, coords.lon], { icon: hotspotIcon });
    marker.setZIndexOffset(1500); // Above both regular peak dots and labels
    // Phase 1 (slice 1): single-track hotspots render into the track's
    // layerGroup. Collective callers don't pass a group → legacy direct add.
    // The group is tagged ALWAYS (even when currently hidden) so toggling the
    // hotspot on later routes it through the group — tagging only inside the
    // `showHotspots` gate made hidden hotspots fall back to direct-to-map adds
    // that survived the track's removal.
    marker._gsrKind = 'hotspot';
    if (layerGroup) {
      marker._gsrLayerGroup = layerGroup;
      if (this.showHotspots) {
        layerGroup.addLayer(marker);
      }
    } else if (this.showHotspots) {
      marker.addTo(this.map);
    }
    this._registerTrackLayer(track, marker);

    marker.bindPopup(() => popupCallback(index, coords, marker));
    if (clickCallback) {
      marker.on('click', () => clickCallback(index));
    }
    return marker;
  },

  _renderHotspotMarkers(analyzer, peakLatency, track) {
    const events = analyzer.memorableEvents;
    if (!events || events.length === 0) return;

    events.forEach(peak => {
      const marker = this._createHotspotMarker(
        analyzer,
        peak,
        peakLatency,
        (index, coords, m) => MapPopups.buildSinglePeakPopup(analyzer, peak, index, coords, m),
        (index) => GSRUI.focusOnPeak(index, 'map'),
        track
      );
    });
  },

  /**
   * Collective/multi-track counterpart to _renderHotspotMarkers() — same
   * shared icon (GSRMapManager._buildHotspotIcon()) and position math
   * (_hotspotMarkerCoords()), so the two views can't visually drift apart.
   * Popup/interaction wiring follows the existing collective peak-marker
   * convention instead of the single-track one: bindPopup only, no
   * click-to-focus — collective view has no single "active track" for a
   * focus action to target (see the regular per-track peak markers built
   * just above this method's call site in renderCollectiveData()).
   * @private
   */
  _renderCollectiveTrackHotspots(track, peakLatency) {
    const analyzer = track.analyzer;
    const events = analyzer.memorableEvents;
    if (!events || events.length === 0) return;

    events.forEach(peak => {
      const marker = this._createHotspotMarker(
        analyzer,
        peak,
        peakLatency,
        (index, coords, m) => MapPopups.buildCollectivePeakPopup(track, peak, index, coords.lat, coords.lon, m),
        null,
        track
      );
    });
  },

  /**
   * Render one track's collective-mode peak dot markers + connector lines,
   * with 360° label-collision avoidance scoped to just this track's own
   * peaks (collectiveLabelCandidates/collectiveAllPeaks are per-call, not
   * shared across tracks — a label change on one track can't perturb
   * another track's layout). Shared by renderCollectiveData() (full
   * rebuild, passes activePeaksSink so non-excluded peaks feed the global
   * clustering pass) and refreshCollectivePeakMarkers() (label-edit-only
   * partial refresh, passes null — see that method's doc comment for why
   * skipping the clustering push is correct there).
   * @private
   */
  _renderCollectiveTrackPeaks(track, layerGroup, trackColor, peakLatency, activePeaksSink) {
    const map = this.map;
    const collectiveLabelCandidates = [];
    const collectiveAllPeaks = [];

    // First pass: collect pixel positions (with latency compensation)
    track.analyzer.peaks.forEach((peak, index) => {
      // Original (unshifted) GPS position for connector line
      const origCoords = track.analyzer.getCoordinates(peak.index);

      // Shifted position (with latency)
      const si = this._resolveLatencyIndex(track.analyzer, peak, peakLatency);
      const coords = track.analyzer.getCoordinates(si);
      if (coords) {
        const pt = map.latLngToLayerPoint([coords.lat, coords.lon]);
        collectiveAllPeaks.push({
          peak, index, lat: coords.lat, lon: coords.lon, px: pt.x, py: pt.y,
          origLatLon: origCoords ? [origCoords.lat, origCoords.lon] : null
        });
        if (peak.label && peak.label.trim()) {
          collectiveLabelCandidates.push({ idx: index, px: pt.x, py: pt.y, text: peak.label });
        }
        if (activePeaksSink && !peak.excluded) {
          activePeaksSink.push({
            lat: coords.lat,
            lon: coords.lon,
            amplitude: peak.amplitude,
            trackId: track.id,
            time: peak.time,
            sampleIndex: peak.index
          });
        }
      }
    });

    // 360° collision avoidance for collective labels
    const collectivePositions = GSRLabelManager.computeLabelPositions(collectiveLabelCandidates);

    // Compact dot-only icon for unlabelled peaks — the same shared icon
    // single-track peaks use (GSRMapManager._buildPeakIcon()), not
    // per-track-coloured, so a peak looks identical regardless of which view
    // it's shown in.
    const collectiveSimpleIcon = GSRMapManager._buildPeakIcon();

    collectiveAllPeaks.forEach(({ peak, index, lat, lon, px, py }) => {
      const displayLabel = peak.label || '';

      let marker;
      const hasLabel = displayLabel && displayLabel.trim();
      if (hasLabel) {
        const dirResult = collectivePositions.get(index);
        if (dirResult) {
          marker = L.marker([lat, lon], {
            icon: GSRLabelManager.buildLabelledIcon(px, py, displayLabel, dirResult, { showGlow: false, dotPx: 6 })
          });
          // Bump labelled markers above everything else on the map
          marker.setZIndexOffset(1000);
          marker.hasLabel = true;
        } else {
          marker = L.marker([lat, lon], { icon: collectiveSimpleIcon });
          marker.hasLabel = false;
        }
      } else {
        marker = L.marker([lat, lon], { icon: collectiveSimpleIcon });
        marker.hasLabel = false;
      }

      marker.bindPopup(() => MapPopups.buildCollectivePeakPopup(track, peak, index, lat, lon, marker));

      // Phase 1 (slice 2/3): collective peak markers render into this track's
      // own layerGroup; the peak index is tagged so focusOnPeak can resolve it.
      // Tag the group ALWAYS (even when currently hidden) so toggling the
      // marker on later routes it through the group — tagging only when
      // visible made hidden markers fall back to direct-to-map adds that
      // survived the track's removal.
      marker._gsrKind = 'collectivePeak';
      marker._gsrPeakIndex = index;
      marker._gsrLayerGroup = layerGroup;
      const shouldAdd = this.showPeaks || (this.showLabels && marker.hasLabel);
      if (shouldAdd) {
        layerGroup.addLayer(marker);
      }
      // Dim excluded peak markers
      if (peak.excluded) {
        marker.setOpacity(0.35);
      }
      this._registerTrackLayer(track, marker);
    });

    // Draw connector lines from original to shifted position (collective)
    if (peakLatency > 0) {
      for (const ap of collectiveAllPeaks) {
        if (!ap.origLatLon) continue;
        const shiftedLatLon = [ap.lat, ap.lon];
        const conn = L.polyline([ap.origLatLon, shiftedLatLon], {
          color: trackColor,
          weight: 1,
          opacity: 0.25,
          dashArray: '2, 4'
        });
        conn._gsrKind = 'collectiveConnector';
        conn._gsrLayerGroup = layerGroup;
        layerGroup.addLayer(conn);
        this._registerTrackLayer(track, conn);
      }
    }
  },

  /**
   * Re-render ONLY one track's collective-mode peak dot markers + connector
   * lines — used by updatePeakLabel() in collective view. A label edit only
   * ever changes that one peak's label chip/popup plus this track's own
   * 360° label-collision layout (see _renderCollectiveTrackPeaks's doc
   * comment: that layout is computed per-track, not globally) — nothing
   * else in collective mode reads peak.label. Path, hotspots, clusters, and
   * the contour surface are all left untouched by reference.
   *
   * Deliberately NOT reused for togglePeakExclusion() in collective mode:
   * `excluded` IS read by both the global clustering pass
   * (allActivePeaksAcrossTracks in renderCollectiveData()) and
   * generateContourSurface() (collective_manager.js, when topographySource
   * is 'peaks') — both full-dataset computations across every active track,
   * not per-track, so an exclusion toggle still needs the full
   * renderCollectiveData() rebuild to stay correct. See the Phase 6 step 2
   * investigation note in docs/archive/visualizer_architecture_refactor_plan.md.
   *
   * Falls back to GSRUI.updateCollectiveMap() (the full rebuild) when the
   * track isn't a currently-active/rendered one (no layerGroup to refresh
   * into) — same reasoning as refreshPeakMarkers()'s no-track fallback.
   */
  refreshCollectivePeakMarkers(track, peakLatency) {
    if (!this.map) return;
    if (!track || !track.layerGroup) {
      if (typeof GSRUI !== 'undefined' && typeof GSRUI.updateCollectiveMap === 'function') {
        GSRUI.updateCollectiveMap();
      }
      return;
    }

    const layerGroup = track.layerGroup;
    const trackColor = track.color || '#0ea5e9';

    this._refreshTrackLayers(
      track,
      new Set(['collectivePeak', 'collectiveConnector']),
      () => this._renderCollectiveTrackPeaks(track, layerGroup, trackColor, peakLatency || 0, null),
      true
    );
  },

  /**
   * Resolve the raw-sample index a marker should be positioned at, applying
   * the optional GPS-latency shift (find the GPS fix at peak.time -
   * peakLatency instead of peak.time itself, falling back to peak.index if
   * nothing is found there). Shared by _renderPeakMarkers(),
   * _renderHotspotMarkers() and _renderCollectiveTrackHotspots().
   * @private
   */
  _resolveLatencyIndex(analyzer, peak, peakLatency) {
    if (analyzer && typeof analyzer.resolveLatencyIndex === 'function') {
      return analyzer.resolveLatencyIndex(peak, peakLatency);
    }
    if (!(peakLatency > 0)) return peak.index;
    const shiftedTime = Math.max(0, peak.time - peakLatency);
    const si = analyzer.findClosestIndex(shiftedTime);
    return si >= 0 ? si : peak.index;
  },

  /**
   * Resolve the {lat, lon} position for a hotspot marker. Shared by both
   * _renderHotspotMarkers() and _renderCollectiveTrackHotspots().
   * @private
   */
  _hotspotMarkerCoords(analyzer, peak, peakLatency) {
    return analyzer.getCoordinates(this._resolveLatencyIndex(analyzer, peak, peakLatency));
  },

  /**
   * Mean amplitude across a set of {amplitude} peak objects. Used as the reference point
   * for relative-severity scaling of cluster geometry and styling.
   * @private
   */
  _meanAmplitude(pts) {
    if (!pts || pts.length === 0) return 0;
    let sum = 0;
    for (const p of pts) sum += (p.amplitude || 0);
    return sum / pts.length;
  },

  /**
   * Outline style for one Stress Place (the numbered badge is styled separately
   * by rank in _renderStressPlaces).
   *
   * Collective view (2+ active tracks): the ramp is driven by inter-track
   * *agreement* — trackCount / activeTrackCount — so a spot several independent
   * walkers reacted to reads as strong, and a one-walker place renders faint
   * and dashed ("provisional").
   *
   * Single-track view (or a lone collective track): the ramp is the
   * dwell-normalised `rate`, min→max-normalised across the places in this
   * render, amber → red.
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
    const hue = 40 - ratio * 40;     // amber -> red
    const sat = 75 + ratio * 20;
    const light = 58 - ratio * 15;
    const color = `hsl(${hue}, ${sat}%, ${light}%)`;
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
   * Read the single "Place Merge Distance" slider (#placeMergeDistance) and
   * derive the cosmetic outline params. mergeM is the single-linkage grouping
   * epsilon; sigma / blobRadius only shape the concave outline in
   * getConcaveBlob(), not the place score.
   * @private
   */
  _getClusteringParams() {
    const C = (typeof GSR_CONST !== 'undefined' && GSR_CONST.STRESS_PLACES) ? GSR_CONST.STRESS_PLACES : {};
    const fallback = C.mergeM || 35;
    let mergeM = AppState.sliders.placeMergeDistance
      ? parseFloat(AppState.sliders.placeMergeDistance.value)
      : fallback;
    if (isNaN(mergeM)) mergeM = fallback;

    return {
      mergeM,
      sigma: mergeM * 0.35,
      blobRadius: mergeM * 0.5
    };
  }

});

Object.assign(GSRMapManager, {

  /**
   * Build the shared Leaflet divIcon for every hotspot marker on the map —
   * single-track (_renderHotspotMarkers) and collective/multi-track
   * (renderCollectiveData) both call it, so the two views can't drift apart
   * visually. The glyph is a red star (★, .hotspot-star), consistent across the
   * GSR graph, the 2D map and the 3D globe (peaks are a small circle
   * everywhere; hotspots are a star). Behind it sits the expanding pulse-glow
   * ring (.hotspot-glow-ring, styles.css): peak markers are static (see
   * drawPeakMarkers() in renderer.js), so the animation is reserved for the
   * small curated hotspot set, to draw the eye to what matters.
   * @private
   */
  _buildHotspotIcon() {
    return L.divIcon({
      className: '',
      html: '<div class="stress-peak-icon-wrapper" style="position:relative;width:28px;height:28px;">' +
        '<div class="hotspot-glow-ring" style="position:absolute;top:0;left:0;"></div>' +
        '<div class="hotspot-star" style="position:absolute;top:0;left:0;width:28px;height:28px;">★</div>' +
        '</div>',
      iconSize: [28, 28], iconAnchor: [14, 14]
    });
  },

  /**
   * Build the shared Leaflet divIcon for every unlabelled, non-hotspot peak
   * marker — single-track (_renderPeakMarkers) and collective/multi-track
   * (renderCollectiveData) both call it, so a peak looks identical on both
   * views: small, quality-neutral --color-peak red dot, no per-track colour, no
   * animation. In collective view you tell tracks apart by clicking a marker
   * (the popup shows the track name), not by dot colour.
   * @private
   */
  _buildPeakIcon() {
    return L.divIcon({
      className: '',
      html: '<div class="stress-peak-icon-wrapper" style="position:relative;width:24px;height:24px;"><div class="peak-dot" style="position:absolute;top:9px;left:9px;width:6px;height:6px;"></div></div>',
      iconSize: [24, 24], iconAnchor: [12, 12]
    });
  }

});
