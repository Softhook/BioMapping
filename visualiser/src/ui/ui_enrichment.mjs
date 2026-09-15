/**
 * GSRUI — spatial enrichment (OSM + NDVI). Object-augment split from ui.js:
 * loaded immediately after ui.js, adds these methods to the shared GSRUI
 * object.
 *
 * Covers resolving which tracks are eligible for spatial analysis, the
 * shared progress-bar control, and the async fetch/enrichment pipelines
 * (ensureOsmGeoms, enrichTrack, sampleNdviTrack) that populate each
 * analyzer's per-point spatial metadata.
 */
import { AppState } from '../core/app_state.mjs';
import { NDVISampler } from '../osm/ndvi_sampler.mjs';
import { OsmCache } from '../osm/osm_cache.mjs';
import { OSMEnricher } from '../osm/osm_enrichment.mjs';
import { GSRUI } from './ui.mjs';

export const __methods = {
  /**
   * Resolve active tracks with valid GPS fixes for environmental/spatial processing.
   * Shared by OpenStreetMap enrichment and satellite NDVI sampling.
   *
   * @param {Object} [options={}] - { silent: boolean, featureLabel: string }
   * @returns {{ allTracks: Array<Object>, validTracks: Array<Object> }}
   */
  getSpatialTracks(options = {}) {
    const silent = Boolean(options.silent);
    const featureLabel = options.featureLabel || 'spatial data retrieval';
    const isCollective = AppState.viewMode === 'collective';

    let allTracks = [];
    if (isCollective) {
      if (!AppState.collectiveManager)
        return { allTracks: [], validTracks: [] };
      allTracks = AppState.collectiveManager.getActiveTracks() || [];
    } else {
      if (AppState.analyzer?.raw && AppState.analyzer.raw.length > 0) {
        const trackObj =
          AppState.collectiveManager && AppState.activeTrackId
            ? AppState.collectiveManager.getTrack(AppState.activeTrackId)
            : null;
        allTracks = [
          {
            id: AppState.activeTrackId,
            name: trackObj?.name || 'Walk',
            analyzer: AppState.analyzer,
          },
        ];
      }
    }

    if (allTracks.length === 0) {
      if (!silent) alert('Please load or select active track files first.');
      return { allTracks: [], validTracks: [] };
    }

    const isValid = (lat, lon) => {
      if (
        typeof NDVISampler !== 'undefined' &&
        typeof NDVISampler._isValidCoord === 'function'
      ) {
        return NDVISampler._isValidCoord(lat, lon);
      }
      if (
        typeof OSMEnricher !== 'undefined' &&
        typeof OSMEnricher._isValidCoord === 'function'
      ) {
        return OSMEnricher._isValidCoord(lat, lon);
      }
      return (
        lat != null &&
        lon != null &&
        !isNaN(lat) &&
        !isNaN(lon) &&
        Math.abs(lat) > 0.001 &&
        Math.abs(lon) > 0.001
      );
    };

    const validTracks = allTracks.filter((t) => {
      if (!t?.analyzer?.raw) return false;
      return t.analyzer.raw.some((pt) => pt && isValid(pt.lat, pt.lon));
    });

    if (validTracks.length === 0) {
      if (!silent)
        alert(
          `No valid GPS coordinates found in the selected track(s). ${featureLabel} requires GPS location fixes.`,
        );
      return { allTracks, validTracks: [] };
    }

    return { allTracks, validTracks };
  },

  getValidTracksForSpatialAnalysis(options = {}) {
    return this.getSpatialTracks(options).validTracks;
  },

  /**
   * Update the spatial processing status container and progress bar.
   * @param {boolean} visible
   * @param {string} [message='']
   * @param {number} [percent=0]
   * @param {string} [color='#ff7b00']
   */
  setSpatialProgress(visible, message = '', percent = 0, color = '#ff7b00') {
    const container = document.getElementById('osmStatusContainer');
    const msgEl = document.getElementById('osmStatusMessage');
    const barEl = document.getElementById('osmProgressBar');

    if (container) container.style.display = visible ? 'block' : 'none';
    if (msgEl && message) msgEl.innerText = message;
    if (barEl) {
      barEl.style.width = `${Math.max(0, Math.min(100, percent))}%`;
      if (color) barEl.style.backgroundColor = color;
    }
  },

  /**
   * Ensure every active track has `analyzer.osmGeoms` (the reconstructed OSM
   * vector geometry the 2D "OSM Shapes" overlay draws), fetching it on demand
   * if it isn't already in memory.
   *
   * This is the lightweight cousin of enrichTrack(): it reconstructs geometry
   * only — no per-position spatial metadata, no `isEnriched`, no environmental
   * dashboard — so the user can see building/park/water outlines without
   * committing to a full spatial-data retrieval. It shares every layer of that
   * retrieval's cache (analyzer.osmJson in memory → OsmCache.getForBBox →
   * one Overpass fetch via OsmCache.planFetch, then OsmCache.store), using the
   * same bbox buffer (max(osmRadius, gpsSnapRadius) + 50) so whichever runs
   * first, the other reuses its cache and nothing double-downloads.
   *
   * @param {(msg: string) => void} [onProgress]
   * @returns {Promise<{ok: boolean, reason?: string, fetched: number,
   *   cached: number, failed: number, tooBig: number}>}
   */
  async ensureOsmGeoms(onProgress) {
    const report = typeof onProgress === 'function' ? onProgress : () => {};
    if (typeof OSMEnricher === 'undefined' || typeof OsmCache === 'undefined') {
      return {
        ok: false,
        reason: 'unavailable',
        fetched: 0,
        cached: 0,
        failed: 0,
        tooBig: 0,
      };
    }

    const { validTracks } = this.getSpatialTracks({
      silent: true,
      featureLabel: 'OSM shapes',
    });
    if (validTracks.length === 0) {
      return {
        ok: false,
        reason: 'no-gps',
        fetched: 0,
        cached: 0,
        failed: 0,
        tooBig: 0,
      };
    }

    const osmRadius =
      parseInt(document.getElementById('osmRadius')?.value, 10) || 50;
    const snapRadius =
      parseInt(document.getElementById('gpsSnapRadius')?.value, 10) || 25;
    const bufferM = Math.max(osmRadius, snapRadius) + 50;
    const AREA_CAP_KM2 = 12.0;

    let fetched = 0,
      cached = 0,
      failed = 0,
      tooBig = 0;
    for (const t of validTracks) {
      const analyzer = t.analyzer;
      if (analyzer.osmGeoms) {
        cached++;
        continue;
      }
      try {
        let json = analyzer.osmJson || null;
        if (!json) {
          const bbox = OSMEnricher.calculateBBox(analyzer.raw, bufferM);
          if (!bbox) {
            failed++;
            continue;
          }
          if (OSMEnricher.calculateBBoxAreaKm2(bbox) > AREA_CAP_KM2) {
            tooBig++;
            continue;
          }
          report('Checking local cache…');
          json = await OsmCache.getForBBox(bbox);
          if (json) {
            report('Using cached OpenStreetMap data…');
          } else {
            const plan = await OsmCache.planFetch(bbox);
            report('Fetching OpenStreetMap features…');
            json = await OSMEnricher.fetchOSMData(plan.fetchBBox, (m) =>
              report(m),
            );
            if (json) OsmCache.store(plan.fetchBBox, json, plan.mergeIds);
            fetched++;
          }
        }
        if (!json) {
          failed++;
          continue;
        }
        analyzer.osmJson = json; // shared with enrichTrack's in-memory reuse
        analyzer.osmGeoms = OSMEnricher.reconstructGeometries(json);
      } catch (e) {
        console.warn('ensureOsmGeoms: fetch failed for track', t.id, e);
        failed++;
      }
    }

    const ok = validTracks.some((t) => t.analyzer?.osmGeoms);
    return { ok, fetched, cached, failed, tooBig };
  },

  /**
   * Orchestrates bounding box computation, Overpass fetching, and spatial enrichment.
   */
  async enrichTrack(forceFetch = false) {
    if (GSRUI._enriching) return;

    const { allTracks, validTracks } = this.getSpatialTracks({
      silent: false,
      featureLabel: 'OpenStreetMap spatial data retrieval',
    });
    if (validTracks.length === 0) return;
    const tracksToEnrich = allTracks;

    const btn = document.getElementById('btnEnrichTrack');
    const statusContainer = document.getElementById('osmStatusContainer');
    const statusMsg = document.getElementById('osmStatusMessage');
    const progressBar = document.getElementById('osmProgressBar');

    if (!btn || !statusContainer || !statusMsg || !progressBar) {
      return;
    }

    const originalText = btn.innerHTML;
    GSRUI._enriching = true;
    btn.setAttribute('disabled', 'true');
    btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> Enriching...';

    this.setSpatialProgress(
      true,
      'Initiating OpenStreetMap enrichment...',
      0,
      '#ff7b00',
    );

    const updateProgress = (msg, pct) => {
      this.setSpatialProgress(true, msg, pct, '#ff7b00');
    };

    try {
      const radius =
        parseInt(document.getElementById('osmRadius').value, 10) || 50;
      const snapRadius =
        parseInt(document.getElementById('gpsSnapRadius')?.value, 10) || 25;
      const maxRadius = Math.max(radius, snapRadius);

      // Union bounding box over every valid track's raw coordinates.
      // (Plain loop, not push(...spread) — that overflows the call stack
      // once a collection has tens of thousands of points.)
      const combinedRaw = [];
      for (const t of validTracks) {
        const r = t.analyzer.raw;
        for (let i = 0; i < r.length; i++) combinedRaw.push(r[i]);
      }

      const AREA_CAP_KM2 = 12.0;
      const snapEnabled =
        document.getElementById('gpsSnapToRoads')?.checked ?? false;
      const snapParams = { enabled: snapEnabled, radiusOut: snapRadius };

      const unionBBox = OSMEnricher.calculateBBox(combinedRaw, maxRadius + 50);
      if (!unionBBox) {
        throw new Error(
          'Could not calculate bounding box. Track coordinates may be invalid.',
        );
      }
      const unionArea = OSMEnricher.calculateBBoxAreaKm2(unionBBox);

      // One shared Overpass fetch when the whole collection fits under the
      // area cap (the common case: walks in one neighbourhood). When it
      // doesn't, fetch per track below so a geographically spread-out
      // collection still enriches every track — each walk's own bbox is small.
      let sharedJson = null;
      const singleFetch = unionArea <= AREA_CAP_KM2;
      const allInMem =
        !forceFetch && validTracks.every((t) => t.analyzer.osmJson);

      let sharedFetchFailed = false;
      if (singleFetch && !allInMem) {
        updateProgress('Checking local cache…', 10);
        sharedJson = await OsmCache.getForBBox(unionBBox);
        if (sharedJson) {
          updateProgress('Using cached OpenStreetMap data…', 40);
        } else {
          try {
            const plan = await OsmCache.planFetch(unionBBox);
            if (plan.mergeIds.length > 0) {
              updateProgress(
                `Expanding cached coverage (merging ${plan.mergeIds.length} nearby area${plan.mergeIds.length > 1 ? 's' : ''})…`,
                20,
              );
            }
            updateProgress('Fetching OpenStreetMap features…', 30);
            sharedJson = await OSMEnricher.fetchOSMData(plan.fetchBBox, (msg) =>
              updateProgress(msg),
            );
            OsmCache.store(plan.fetchBBox, sharedJson, plan.mergeIds);
          } catch (sharedErr) {
            // The combined bbox fitting under the area cap doesn't mean the
            // query is cheap — many walks clustered in one dense city area
            // can still time out fetching every building/amenity/tree in
            // the whole union rectangle at once. Previously this aborted
            // enrichment for all N tracks even though each one's own bbox
            // (below) is far smaller and fetches fine individually — fall
            // back to that instead of throwing the batch away.
            console.warn(
              'Shared OSM fetch failed, falling back to per-track fetches:',
              sharedErr,
            );
            updateProgress(
              'Combined-area fetch timed out — falling back to per-track requests…',
              40,
            );
            sharedJson = null;
            sharedFetchFailed = true;
          }
        }
      }

      // Enrich every valid track. One track failing (bad geometry, an
      // oversized bbox, an Overpass error) must not abort the rest.
      let enriched = 0;
      const failed = [];
      const tooBig = [];
      for (let i = 0; i < validTracks.length; i++) {
        const t = validTracks[i];
        const label = t.name || t.id || `track ${i + 1}`;
        const basePct = 45 + Math.round((50 * i) / validTracks.length);
        updateProgress(`[${i + 1}/${validTracks.length}] ${label}…`, basePct);
        try {
          let json =
            sharedJson ||
            (!forceFetch && t.analyzer.osmJson ? t.analyzer.osmJson : null);
          if (!json) {
            const tb = OSMEnricher.calculateBBox(
              t.analyzer.raw,
              maxRadius + 50,
            );
            if (!tb) {
              failed.push(label);
              continue;
            }
            if (OSMEnricher.calculateBBoxAreaKm2(tb) > AREA_CAP_KM2) {
              tooBig.push(label);
              continue;
            }
            json = await OsmCache.getForBBox(tb);
            if (!json) {
              const plan = await OsmCache.planFetch(tb);
              json = await OSMEnricher.fetchOSMData(plan.fetchBBox, (msg) =>
                updateProgress(`[${i + 1}/${validTracks.length}] ${msg}`),
              );
              OsmCache.store(plan.fetchBBox, json, plan.mergeIds);
            }
          }
          t.analyzer.osmJson = json;
          OSMEnricher.enrichTrack(t.analyzer, json, radius, snapParams, (msg) =>
            updateProgress(`[${i + 1}/${validTracks.length}] ${msg}`),
          );
          enriched++;
        } catch (e) {
          console.error('OSM enrichment failed for track', t.id, e);
          failed.push(label);
        }
      }

      updateProgress('Redrawing visualiser…', 96);
      GSRUI.refreshOsmControls();
      GSRUI.rerenderMap();
      // rerenderMap() only touches the Leaflet map — the p5 GSR graph (whose
      // context bands read the same osm_road_class/osm_in_park fields this
      // pass just rewrote, e.g. after a "Snap to Roads" reclassification)
      // otherwise stays stale until the next unrelated interaction redraws it.
      if (typeof redraw === 'function') redraw();

      const noGps = tracksToEnrich.length - validTracks.length;
      const parts = [
        `Enriched ${enriched}/${tracksToEnrich.length} walk${tracksToEnrich.length === 1 ? '' : 's'}`,
      ];
      if (sharedFetchFailed)
        parts.push('combined fetch timed out, used per-track fallback');
      if (noGps > 0) parts.push(`${noGps} without GPS`);
      if (tooBig.length > 0)
        parts.push(`${tooBig.length} too spread out (> ${AREA_CAP_KM2} km²)`);
      if (failed.length > 0) parts.push(`${failed.length} failed`);
      updateProgress(parts.join(' · '), 100);
      if (enriched === 0) progressBar.style.backgroundColor = 'var(--danger)';
      setTimeout(
        () => {
          statusContainer.style.display = 'none';
        },
        failed.length || tooBig.length ? 6000 : 3000,
      );
    } catch (err) {
      console.error('OSM Enrichment error:', err);
      alert(`OSM Enrichment failed: ${err.message}`);
      statusMsg.innerText = `Error: ${err.message}`;
      progressBar.style.backgroundColor = 'var(--danger)';
    } finally {
      btn.removeAttribute('disabled');
      btn.innerHTML = originalText;
      GSRUI._enriching = false;
    }
  },

  /**
   * Sample Point NDVI and 50m Buffer Mean NDVI across active tracks via offscreen canvas streaming.
   */
  async sampleNdviTrack(silent = false) {
    if (GSRUI._samplingNdvi) return;

    const validTracks = this.getValidTracksForSpatialAnalysis({
      silent,
      featureLabel: 'satellite NDVI sampling',
    });
    if (validTracks.length === 0) return;

    GSRUI._samplingNdvi = true;

    const btn = document.getElementById('btnSampleNdvi');
    const originalText = btn ? btn.innerHTML : '';
    if (btn) {
      btn.setAttribute('disabled', 'true');
      btn.innerHTML =
        '<i class="fa-solid fa-spinner fa-spin"></i> Sampling NDVI...';
    }

    this.setSpatialProgress(
      true,
      'Determining satellite coverage...',
      0,
      '#2d6a4f',
    );

    try {
      const res = await NDVISampler.sampleTracks(validTracks, {
        zoom: 15,
        radiusM: 50,
        onProgress: (pct, msg) => {
          this.setSpatialProgress(true, msg, pct, '#2d6a4f');
        },
      });

      GSRUI.refreshOsmControls();
      GSRUI.rerenderMap();
      // Same reasoning as enrichTrack() above: rerenderMap() only touches the
      // Leaflet map, but the p5 GSR graph's NDVI context bands read the
      // ndvi/ndvi_50m fields this sampling pass just wrote.
      if (typeof redraw === 'function') redraw();

      const parts = [
        `Sampled NDVI for ${res.enrichedCount}/${res.totalCount} walk${res.totalCount === 1 ? '' : 's'}`,
      ];
      if (res.mode === 'unified_mosaic') parts[0] += ' (shared mosaic)';
      if (res.tooBigCount > 0) parts.push(`${res.tooBigCount} too spread out`);
      if (res.failedCount > 0) parts.push(`${res.failedCount} failed`);

      // When every walk failed the same way (near-certain given they all hit
      // the same Copernicus instance/layer), show the actual reason instead
      // of just a count — otherwise diagnosing it means opening devtools.
      if (
        res.failedCount > 0 &&
        Array.isArray(res.failedTracks) &&
        res.failedTracks.length > 0
      ) {
        parts.push(res.failedTracks[0].error);
      }

      const statusColor =
        res.failedCount > 0 && res.enrichedCount === 0
          ? 'var(--danger)'
          : '#2d6a4f';
      this.setSpatialProgress(true, parts.join(' · '), 100, statusColor);
      setTimeout(
        () => {
          this.setSpatialProgress(false);
        },
        res.failedCount || res.tooBigCount ? 12000 : 3000,
      );
    } catch (err) {
      console.error('NDVI Sampling error:', err);
      if (!silent) alert(`NDVI Sampling failed: ${err.message}`);
      this.setSpatialProgress(
        true,
        `Error: ${err.message}`,
        100,
        'var(--danger)',
      );
    } finally {
      GSRUI._samplingNdvi = false;
      if (btn) {
        btn.removeAttribute('disabled');
        btn.innerHTML = originalText;
      }
    }
  },
};

Object.assign(GSRUI, __methods);
