/**
 * GSRGlobeManager — peak spires, memorable-event hotspots, and spatial
 * cluster ground blobs.
 * Class layer for GSRGlobeManager peak spires, memorable-event hotspots, and spatial
 * cluster ground blobs (`GSRGlobePeaks extends GSRGlobeRf`).
 *
 * Reads the batched marker collections (this._peakPoints / this._peakLabels /
 * this._hotspotLabels) and entity arrays (this.peakEntities / hotspotEntities /
 * clusterEntities) set up by the base class; _getMetricSeries and its cache
 * stay in globe3d_base.mjs since the wall renderer and the tour waypoint builder
 * read it too.
 */
import { HEIGHT_CAPABLE_METRICS } from './globe3d_base.mjs';
import { GSRGlobeRf } from './rf.mjs';

export class GSRGlobePeaks extends GSRGlobeRf {
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
    if (analyzer && typeof analyzer.resolveLatencyIndex === 'function') {
      return analyzer.getCoordinates(analyzer.resolveLatencyIndex(peak, lat));
    }
    if (!(lat > 0) || typeof analyzer.findClosestIndex !== 'function') {
      return analyzer.getCoordinates(peak.index);
    }
    const si = analyzer.findClosestIndex(Math.max(0, (peak.time || 0) - lat));
    return analyzer.getCoordinates(si >= 0 ? si : peak.index);
  }

  /**
   * Calculate 3D wall extrusion height for a peak sample.
   */
  _peakWallHeight(analyzer, peak) {
    const metric = this.activeColoringMetric;
    const heightMetric = HEIGHT_CAPABLE_METRICS.has(metric)
      ? metric
      : this.heightMetric;
    const heightSeries = this._getMetricSeries(analyzer, heightMetric);
    const val = heightSeries
      ? (heightSeries[peak.index] ?? peak.amplitude ?? 0)
      : (peak.amplitude ?? 0);
    return this.baseHeight + Math.max(0, val) * this.extrusionScale;
  }

  /**
   * Cesium constants reused for every peak/hotspot marker — parsed once, not
   * once per marker (a 900-peak rebuild was re-parsing the same three CSS
   * colours 900 times). Cesium treats these as constant property values, so
   * sharing one instance across entities is safe. Rebuilt lazily so the tests'
   * per-instance Cesium stub is honoured.
   * @private
   */
  _markerConst() {
    if (!this._mc) {
      this._mc = {
        peakRed: Cesium.Color.fromCssColorString('#d10024'),
        latencyRose: Cesium.Color.fromCssColorString('#f43f5e').withAlpha(0.35),
        labelOutline: Cesium.Color.fromCssColorString('#0b0c10'),
        hotspotRed: Cesium.Color.fromCssColorString('#ff1744'),
        labelOffset: new Cesium.Cartesian2(0, -14),
        labelDDC: new Cesium.DistanceDisplayCondition(0.0, 6000.0),
        // Pull every label ~10 m toward the camera in eye space. Labels keep
        // disableDepthTestDistance (never occluded by geometry), but Cesium
        // still distance-sorts the no-depth-test overlay back-to-front, so a
        // label 3 m above its wall could tie and let the translucent wall wash
        // over it as the camera orbits. A small constant eye-offset makes the
        // label win that sort every frame; at any real viewing distance the
        // size change is well under a pixel, so it does not "breathe".
        labelEyeOffset: new Cesium.Cartesian3(0.0, 0.0, -10.0),
      };
    }
    return this._mc;
  }

  /**
   * `peak object -> its index in analyzer.peaks`. Peak and hotspot markers are
   * click-tagged with this index (NOT the filtered render list's) — it's what
   * GSRUI.updatePeakLabel()/togglePeakExclusion() and _peakClickCb expect. Built
   * as a Map because `indexOf` per rendered peak was O(peaks²), ~800k scans on a
   * 900-peak walk. @private
   */
  _peakIndexMap(analyzer) {
    const allPeaks = analyzer?.peaks || [];
    const m = new Map();
    for (let k = 0; k < allPeaks.length; k++) m.set(allPeaks[k], k);
    return m;
  }

  /**
   * Lazily initialize batched primitive collections for peak markers and hotspots.
   * @private
   */
  _ensureMarkerCollections() {
    if (!this.viewer?.scene?.primitives) return;
    if (
      !this._peakPoints &&
      typeof Cesium.PointPrimitiveCollection === 'function'
    ) {
      this._peakPoints = this.viewer.scene.primitives.add(
        new Cesium.PointPrimitiveCollection(),
      );
    }
    if (!this._peakLabels && typeof Cesium.LabelCollection === 'function') {
      this._peakLabels = this.viewer.scene.primitives.add(
        new Cesium.LabelCollection(),
      );
    }
    if (!this._hotspotLabels && typeof Cesium.LabelCollection === 'function') {
      this._hotspotLabels = this.viewer.scene.primitives.add(
        new Cesium.LabelCollection(),
      );
    }
  }

  /**
   * Render the 3D peak markers (a small circle just above the wall top, no
   * vertical stalk) and their labels.
   */
  _renderPeakSpires(analyzer, peaks) {
    if (!peaks || peaks.length === 0) return;
    if (!this.showPeaks && !this.showLabels) return;

    this._ensureMarkerCollections();
    const peakIndexOf = this._peakIndexMap(analyzer);
    const C = this._markerConst();
    const usePrimitives = Boolean(
      this._peakPoints && typeof this._peakPoints.add === 'function',
    );

    peaks.forEach((peak, i) => {
      if (peak.qualityScore < this.minPeakQuality) return;

      // Only labelled peaks get floating text — an unlabelled peak is just its
      // circle (click it to add a label).
      const labelText = peak.label?.trim() ? peak.label.trim() : '';

      // With peaks off, the "Labels" toggle still keeps labelled peaks on
      // screen — the 2D map does the same (a labelled marker survives turning
      // "Peaks" off).
      if (!this.showPeaks && !(this.showLabels && labelText)) return;

      // Index into analyzer.peaks (NOT the filtered `peaks` arg) — this is what
      // GSRUI.updatePeakLabel()/togglePeakExclusion() expect, and what the
      // click handler reports via _peakClickCb.
      const peakIdx = peakIndexOf.has(peak) ? peakIndexOf.get(peak) : -1;

      // Peak position — shifted by the Peak-latency slider, like the 2D map.
      const coords = this._latencyCoords(analyzer, peak);
      if (!coords || isNaN(coords.lat) || isNaN(coords.lon)) return;
      const lat = coords.lat;
      const lon = coords.lon;

      const wallHeight = this._peakWallHeight(analyzer, peak);
      // Circle sits just above the wall top — no vertical stalk.
      const markerPos = Cesium.Cartesian3.fromDegrees(
        lon,
        lat,
        wallHeight + 3.0,
      );

      // Faint connector from the unshifted peak sample to the latency-shifted
      // marker — the 3D counterpart of the 2D dashed rose line (map.js).
      if (this.peakLatency > 0 && this.viewer && this.viewer.entities) {
        const orig = analyzer.getCoordinates(peak.index);
        if (
          orig &&
          !isNaN(orig.lat) &&
          !isNaN(orig.lon) &&
          (orig.lat !== lat || orig.lon !== lon)
        ) {
          const conn = this.viewer.entities.add({
            name: `Peak ${i + 1} latency`,
            polyline: {
              positions: [
                Cesium.Cartesian3.fromDegrees(orig.lon, orig.lat, 1.0),
                Cesium.Cartesian3.fromDegrees(lon, lat, 1.0),
              ],
              width: 1.5,
              material: C.latencyRose,
              clampToGround: true,
            },
          });
          conn._biomapPeakIndex = peakIdx;
          this.peakEntities.push(conn);
        }
      }

      // Small circle marking the peak — the main click target. Depth-tested
      // (no disableDepthTestDistance): the circle occludes correctly behind
      // walls/terrain AND, crucially, stays out of Cesium's "always on top"
      // billboard overlay so it can never be drawn over a peak label. The
      // label is the strict top layer; the circle is not.
      if (usePrimitives) {
        const pt = this._peakPoints.add({
          position: markerPos,
          pixelSize: 5,
          color: C.peakRed,
          outlineColor: Cesium.Color.WHITE,
          outlineWidth: 1,
          id: { _biomapPeakIndex: peakIdx },
        });
        pt._biomapPeakIndex = peakIdx;
        // Marks this entry as the batched circle primitive (not a latency
        // connector entity) for clearPeakEntities() and focusOnPeakLocation().
        pt._isPeakPointPrimitive = true;
        this.peakEntities.push(pt);
      } else if (this.viewer?.entities) {
        const beaconEntity = this.viewer.entities.add({
          name: `Peak ${i + 1}`,
          position: markerPos,
          point: {
            pixelSize: 5,
            color: C.peakRed,
            outlineColor: Cesium.Color.WHITE,
            outlineWidth: 1,
          },
        });
        beaconEntity._biomapPeakIndex = peakIdx;
        this.peakEntities.push(beaconEntity);
      }

      if (labelText && this.showLabels) {
        if (this._peakLabels && typeof this._peakLabels.add === 'function') {
          this._peakLabels.add({
            position: markerPos,
            text: labelText,
            font: '600 14px Inter, "Helvetica Neue", Arial, sans-serif',
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            fillColor: Cesium.Color.WHITE,
            outlineColor: C.labelOutline,
            outlineWidth: 3,
            verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
            pixelOffset: C.labelOffset,
            eyeOffset: C.labelEyeOffset,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
            distanceDisplayCondition: C.labelDDC,
            id: { _biomapPeakIndex: peakIdx },
          });
        } else if (this.viewer?.entities) {
          this.viewer.entities.add({
            name: `Peak ${i + 1} label`,
            position: markerPos,
            label: {
              text: labelText,
              font: '600 14px Inter, "Helvetica Neue", Arial, sans-serif',
              style: Cesium.LabelStyle.FILL_AND_OUTLINE,
              fillColor: Cesium.Color.WHITE,
              outlineColor: C.labelOutline,
              outlineWidth: 3,
              verticalOrigin: Cesium.VerticalOrigin.BOTTOM,
              pixelOffset: C.labelOffset,
              eyeOffset: C.labelEyeOffset,
              disableDepthTestDistance: Number.POSITIVE_INFINITY,
              distanceDisplayCondition: C.labelDDC,
            },
          });
        }
      }
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
    const events = analyzer?.memorableEvents;
    if (!events || events.length === 0 || !this.viewer) return;

    this._ensureMarkerCollections();
    const peakIndexOf = this._peakIndexMap(analyzer);
    const C = this._markerConst();
    const useLabels = Boolean(
      this._hotspotLabels && typeof this._hotspotLabels.add === 'function',
    );

    events.forEach((peak) => {
      // A hotspot IS a peak (memorableEvents references analyzer.peaks), and
      // _renderPeakSpires()'s caller already filters excluded peaks out of
      // `currentPeaks` before drawing spires — mirror that here so an
      // excluded peak's star doesn't keep showing as curated/important after
      // memorableEvents itself may not have been recomputed since the toggle.
      if (peak.excluded) return;

      const coords = this._latencyCoords(analyzer, peak);
      if (!coords || isNaN(coords.lat) || isNaN(coords.lon)) return;

      const peakIdx = peakIndexOf.has(peak) ? peakIndexOf.get(peak) : -1;
      const wallHeight = this._peakWallHeight(analyzer, peak);
      const tipHeight = wallHeight + 11.0; // sits above the regular peak circle

      if (useLabels) {
        const star = this._hotspotLabels.add({
          position: Cesium.Cartesian3.fromDegrees(
            coords.lon,
            coords.lat,
            tipHeight,
          ),
          text: '★',
          font: '700 14px "Helvetica Neue", Arial, sans-serif',
          style: Cesium.LabelStyle.FILL_AND_OUTLINE,
          fillColor: C.hotspotRed,
          outlineColor: C.labelOutline,
          outlineWidth: 2,
          verticalOrigin: Cesium.VerticalOrigin.CENTER,
          horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
          eyeOffset: C.labelEyeOffset,
          disableDepthTestDistance: Number.POSITIVE_INFINITY,
          id: { _biomapPeakIndex: peakIdx },
        });
        star._biomapPeakIndex = peakIdx;
        star._isHotspotLabelPrimitive = true; // batched label, not an entity
        this.hotspotEntities.push(star);
      } else if (this.viewer?.entities) {
        const star = this.viewer.entities.add({
          name: 'Hotspot',
          position: Cesium.Cartesian3.fromDegrees(
            coords.lon,
            coords.lat,
            tipHeight,
          ),
          label: {
            text: '★',
            font: '700 14px "Helvetica Neue", Arial, sans-serif',
            style: Cesium.LabelStyle.FILL_AND_OUTLINE,
            fillColor: C.hotspotRed,
            outlineColor: C.labelOutline,
            outlineWidth: 2,
            verticalOrigin: Cesium.VerticalOrigin.CENTER,
            horizontalOrigin: Cesium.HorizontalOrigin.CENTER,
            eyeOffset: C.labelEyeOffset,
            disableDepthTestDistance: Number.POSITIVE_INFINITY,
          },
        });
        star._biomapPeakIndex = peakIdx;
        this.hotspotEntities.push(star);
      }
    });
  }

  /**
   * Cheap content fingerprint of the current cluster hulls + their visibility.
   * `_pushFromMap` rebuilds `clusterPolygons` (a fresh array, fresh rings) on
   * every 2D `map:rendered`, but the hulls themselves only change when the merge
   * slider or the active-peak set moves — so the fingerprint, not array
   * identity, decides whether the ground blobs need rebuilding. @private
   */
  _clusterBlobSignature() {
    const polys = this.currentClusterPolygons || [];
    if (!polys.length) return this.showClusters ? 'empty' : 'off';
    let s = (this.showClusters ? 'on:' : 'off:') + polys.length;
    for (const p of polys) {
      const ring = p?.ring || [];
      s +=
        '|' +
        ring.length +
        ',' +
        (p.color || '') +
        ',' +
        (p.fillOpacity == null ? '' : p.fillOpacity);
      if (ring.length) {
        const a = ring[0],
          m = ring[ring.length >> 1];
        s +=
          ',' +
          (+a[0]).toFixed(5) +
          ',' +
          (+a[1]).toFixed(5) +
          ',' +
          (+m[0]).toFixed(5) +
          ',' +
          (+m[1]).toFixed(5);
      }
    }
    return s;
  }

  /**
   * Rebuild the ground blobs only when the hulls or the Clusters toggle changed
   * since the last sync — otherwise the existing clamp-to-ground entities stay
   * put (no remove+add blink). @private
   */
  _syncClusterBlobs() {
    const sig = this._clusterBlobSignature();
    if (sig === this._clusterBlobSig) return;
    this.clearClusterEntities();
    if (this.showClusters) this._renderClusterBlobs();
    this._clusterBlobSig = sig;
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

    polys.forEach((poly) => {
      const ring = poly?.ring || [];
      if (ring.length < 3) return;

      const flat = [];
      let sumLat = 0,
        sumLon = 0;
      for (let i = 0; i < ring.length; i++) {
        flat.push(ring[i][1], ring[i][0]); // [lat,lon] -> lon,lat
        sumLat += ring[i][0];
        sumLon += ring[i][1];
      }
      const positions = Cesium.Cartesian3.fromDegreesArray(flat);
      const baseColor = Cesium.Color.fromCssColorString(
        poly.color || '#ff5252',
      );
      const fillAlpha = poly.fillOpacity != null ? poly.fillOpacity : 0.25;

      const fillEnt = this.viewer.entities.add({
        name: 'Arousal place',
        polygon: {
          hierarchy: new Cesium.PolygonHierarchy(positions),
          material: baseColor.withAlpha(fillAlpha),
          classificationType: Cesium.ClassificationType.BOTH,
        },
      });
      this.clusterEntities.push(fillEnt);

      // The outline is NOT clamp-to-ground: a ground polyline and the
      // ClassificationType fill resolve depth in different passes and shimmer
      // where they coincide. Lift it a few cm above the surface instead — over
      // the sampled terrain height when Cesium World Terrain is on, else 0
      // (the flat ellipsoid the rest of the 3D scene is built against).
      // Solid colour, not PolylineDashMaterialProperty: Cesium recomputes the
      // dash pattern relative to the camera every frame, which reads as the
      // outline crawling whenever the camera moves.
      const groundH = this._groundHeightAt(
        sumLat / ring.length,
        sumLon / ring.length,
      );
      const outH = groundH + 0.3;
      const outFlat = [];
      for (let i = 0; i < ring.length; i++) {
        outFlat.push(ring[i][1], ring[i][0], outH);
      }
      outFlat.push(ring[0][1], ring[0][0], outH); // close the ring
      const outlineEnt = this.viewer.entities.add({
        polyline: {
          positions: Cesium.Cartesian3.fromDegreesArrayHeights(outFlat),
          width: 2.0,
          material: baseColor.withAlpha(0.9),
        },
      });
      this.clusterEntities.push(outlineEnt);
    });
  }
}
