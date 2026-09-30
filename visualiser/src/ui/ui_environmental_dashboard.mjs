/**
 * GSRUI — environmental dashboard orchestration. Object-augment split from
 * ui.js: loaded immediately after ui.js, adds this method to the shared
 * GSRUI object.
 *
 * updateEnvironmentalDashboard() is the single entry point that assembles
 * the whole dashboard: it picks the walks, caches the stats
 * (spatial/environmental_stats.mjs computes them) and hands them to the
 * correlation table (ui_correlation_table.js), the road profile
 * (ui_road_profile.js), and the scatter plots.
 */
import { AppState } from '../core/app_state.mjs';
import { GpsPipeline } from '../gps/gps_pipeline.mjs';
import { JunctionResponse } from '../gps/junction_response.mjs';
import { OSMEnricher } from '../osm/osm_enrichment.mjs';
import { EnvironmentalStats } from '../spatial/environmental_stats.mjs';
import { GSRStorage } from './storage.mjs';

export const EnvironmentalDashboardUI = {
  updateEnvironmentalDashboard() {
    const isCollective = AppState.viewMode === 'collective';

    // Every active track (the walks the user has toggled on), and the
    // enriched subset the analysis can actually use.
    // In collective mode: all active tracks. In single mode: just the active track.
    const allActive = isCollective
      ? AppState.collectiveManager?.getActiveTracks
        ? AppState.collectiveManager.getActiveTracks()
        : AppState.analyzer
          ? [{ id: AppState.activeTrackId, analyzer: AppState.analyzer }]
          : []
      : AppState.analyzer
        ? [{ id: AppState.activeTrackId, analyzer: AppState.analyzer }]
        : [];
    const activeTracks = allActive.filter((t) => t.analyzer?.isEnriched);
    const totalWalks = allActive.length;

    if (activeTracks.length === 0) return;

    // The Response delay each walk is shown at (the project's one value) —
    // it decides which place every reading is paired with.
    const delaySig = activeTracks
      .map((t) => t.analyzer.responseDelay)
      .join(',');
    const trackIdsStr = activeTracks.map((t) => t.id).join(',');
    // Positions come from the smoothed path the map draws — built here too,
    // since a walk the map hasn't drawn yet has none.
    for (const t of activeTracks) {
      GpsPipeline.ensureFilteredGps(
        t.analyzer,
        t.gpsFilterParams ||
          AppState.collectiveManager?.getTrack?.(t.id)?.gpsFilterParams,
      );
    }
    // Per-track mutation fingerprint (analyzer._dataVersion is bumped by
    // analyze(), setPeakLabel(), setPeakExcluded(), enrichTrack(); _pathKey
    // changes with the GPS settings). In the cache key, so the cache
    // self-invalidates on any of them.
    const versionSig = activeTracks
      .map((t) => `${t.analyzer?._dataVersion || 0}/${t.analyzer?._pathKey}`)
      .join(',');

    // Cache on the analyzer (single active mode) or the collective manager
    // (all mode — survives active-track switches).
    const effectiveScope = isCollective ? 'all' : 'active';
    const cacheTarget =
      effectiveScope === 'active'
        ? AppState.analyzer
        : AppState.collectiveManager || AppState.analyzer;
    const cache = cacheTarget._cachedEnvStats;
    const needsRecalc =
      !cache ||
      cache.scope !== effectiveScope ||
      cache.delay !== delaySig ||
      cache.trackCount !== activeTracks.length ||
      cache.trackIds !== trackIdsStr ||
      cache.versionSig !== versionSig;

    if (needsRecalc) {
      cacheTarget._cachedEnvStats = {
        scope: effectiveScope,
        delay: delaySig,
        trackCount: activeTracks.length,
        trackIds: trackIdsStr,
        versionSig,
        ...EnvironmentalStats.compute(activeTracks),
      };
    }

    // ── Render from the cache ─────────────────────────────────────────────
    const cachedStats = cacheTarget._cachedEnvStats;
    const hasEmFog = cachedStats.correlationMatrix.some(
      (r) => r.key === 'em_fog',
    );
    const hasSpeed = (cachedStats.allData || []).some(
      (d) => typeof d.speed === 'number' && d.speed > 0,
    );
    const hasNdvi = (cachedStats.allData || []).some(
      (d) => !isNaN(d.ndvi) || !isNaN(d.ndvi_50m),
    );

    // enriched-walk count is cached; totalWalks (incl. not-yet-enriched) is live.
    this.syncScatterEnvOptions(hasEmFog, hasSpeed, hasNdvi);
    this.renderCorrelationTable(
      cachedStats.correlationMatrix,
      cachedStats.trackCount,
      totalWalks,
    );
    this.drawRegressionScatterPlot(cachedStats.allData);
    this.renderRoadProfile(cachedStats.roadProfile, cachedStats.roadComparison);
    this.renderJunctionsTable(
      this._junctionStatsFor(
        cacheTarget,
        effectiveScope,
        activeTracks,
        trackIdsStr,
        versionSig,
        delaySig,
      ),
    );
  },

  /**
   * Junction turn-vs-straight stats. Independent of the environmental
   * correlations, so it has its own cache (keyed on the Response delay too —
   * the GSR windows move with it) and is only computed while the Junction
   * Turns tab is showing; otherwise the last result (or an empty placeholder)
   * is returned without doing any work.
   */
  _junctionStatsFor(
    cacheTarget,
    scope,
    activeTracks,
    trackIdsStr,
    versionSig,
    delaySig,
  ) {
    const snapRadius = GSRStorage.readSnapRadius();
    const key = [scope, trackIdsStr, versionSig, snapRadius, delaySig].join(
      '|',
    );
    const cached = cacheTarget._cachedJunctionStats;
    if (cached?.key === key) return cached.stats;
    const tab = document.getElementById('envTabJunctions');
    if (tab?.classList && !tab.classList.contains('active')) {
      return (
        cached?.stats || {
          passages: [],
          responses: [],
          comparison: [],
          overview: [],
          tracksNeedingGeoms: 0,
        }
      );
    }
    const stats = this._computeJunctionStats(activeTracks, snapRadius);
    cacheTarget._cachedJunctionStats = { key, stats };
    return stats;
  },

  _computeJunctionStats(activeTracks, snapRadius) {
    // ── Junction turn vs straight analysis ───────────────────────────
    const allPassages = [];
    const allJunctionResponses = [];

    activeTracks.forEach((track) => {
      const a = track.analyzer;
      if (!a?.isEnriched) return;

      // Snapping for analysis only: never turns map snapping on as a side effect.
      const found = OSMEnricher.junctionPassages(a, snapRadius);
      if (!found || found.passages.length === 0) return;
      const passages = found.passages.map((p) => ({
        ...p,
        trackId: track.id,
      }));
      allPassages.push(...passages);

      // Build series for JunctionResponse.responses
      const pLen = a.phasic ? a.phasic.length : 0;
      if (pLen === 0) return;

      const pTimes = new Array(pLen);
      const pVals = new Array(pLen);
      const tVals = new Array(pLen);
      const isPeak = new Uint8Array(pLen);

      for (let i = 0; i < pLen; i++) {
        pTimes[i] = a.phasic[i].time;
        pVals[i] = a.phasic[i].val;
        tVals[i] = a.tonic?.[i] ? a.tonic[i].val : 0;
      }

      if (a.peaks && a.peaks.length > 0) {
        const fallbackTimes = [];
        for (const pk of a.peaks) {
          if (pk.excluded) continue;
          if (pk.index != null && pk.index >= 0 && pk.index < pLen) {
            isPeak[pk.index] = 1;
          } else if (pk.time != null) {
            fallbackTimes.push(pk.time);
          }
        }
        if (fallbackTimes.length > 0) {
          const timeSet = new Set(
            fallbackTimes.map((t) => Math.round(t * 100) / 100),
          );
          for (let i = 0; i < pLen; i++) {
            if (timeSet.has(Math.round(pTimes[i] * 100) / 100)) {
              isPeak[i] = 1;
            }
          }
        }
      }

      const series = {
        time: pTimes,
        phasic: pVals,
        tonic: tVals,
        isPeak,
      };

      const resps = JunctionResponse.responses(passages, series, {
        trackId: track.id,
        delayS: track.analyzer.responseDelay,
      });
      if (resps && resps.length > 0) {
        allJunctionResponses.push(...resps);
      }
    });

    let junctionComparison = [];
    let junctionOverview = [];
    if (allJunctionResponses.length > 0) {
      junctionComparison = JunctionResponse.compare(allJunctionResponses);
      junctionOverview =
        JunctionResponse.compareJunctionVsRoad(allJunctionResponses);
    }

    const tracksNeedingGeoms = activeTracks.filter(
      (t) => !t.analyzer?.osmGeoms?.ways,
    );

    return {
      passages: allPassages,
      responses: allJunctionResponses,
      comparison: junctionComparison,
      overview: junctionOverview,
      tracksNeedingGeoms: tracksNeedingGeoms.length,
    };
  },
};
