// Copyright (c) 2026 Christian Nold
// Licensed under the Bio Mapping Community Licence 1.0.
// See LICENCE.md in the project root for terms.

/**
 * Slider value-label descriptors — single source of truth for how slider
 * live values are rendered next to their controls.
 */

export function fmtMaxSpeed(v) {
  const mode = v <= 3.5 ? 'Walk' : v <= 6.5 ? 'Run' : 'Bike';
  return `${v.toFixed(1)} m/s (${mode})`;
}

export const GSR_SLIDER_DEFS = [
  { id: 'medianSize', labelId: 'valMedianSize', suffix: ' s' },
  { id: 'lpfWindow', labelId: 'valLpfWindow', suffix: ' s' },
  { id: 'tonicWindow', labelId: 'valTonicWindow', suffix: ' s' },
  { id: 'peakThreshold', labelId: 'valPeakThreshold', suffix: ' μS' },
  { id: 'minPeakQuality', labelId: 'valMinPeakQuality', suffix: '' },
  { id: 'hotspotPercentile', labelId: 'valHotspotPercentile', suffix: ' %' },
  { id: 'shapeMinSnr', labelId: 'valShapeMinSnr', suffix: '×' },
];

export const GPS_SLIDER_DEFS = [
  {
    id: 'gpsMaxHdop',
    labelId: 'valGpsMaxHdop',
    fmt: (v) => `≤ ${v.toFixed(1)}`,
    bindGps: true,
  },
  {
    id: 'gpsMaxSpeed',
    labelId: 'valGpsMaxSpeed',
    fmt: (v) => fmtMaxSpeed(v),
    bindGps: true,
  },
  {
    id: 'gpsRDP',
    labelId: 'valGpsRDP',
    fmt: (v) => (v === 0 ? 'off' : `${v} m`),
    bindGps: true,
  },
  {
    id: 'gpsTrackWeight',
    labelId: 'valGpsTrackWeight',
    fmt: (v) => `${v} px`,
    bindGps: true,
  },
  {
    id: 'gpsPeakLatency',
    labelId: 'valGpsPeakLatency',
    fmt: (v) => `${v.toFixed(1)} s`,
  },
  { id: 'gpsSnapRadius', labelId: 'valGpsSnapRadius', fmt: (v) => `${v} m` },
  {
    id: 'placeMergeDistance',
    labelId: 'valPlaceMergeDistance',
    fmt: (v) => `${v} m`,
  },
  {
    id: 'maxArousalPlaces',
    labelId: 'valMaxArousalPlaces',
    fmt: (v) => `${Math.round(v)}`,
  },
];

export const CONTOUR_SLIDER_DEFS = [
  {
    id: 'gridResolution',
    labelId: 'valGridResolution',
    fmt: (v) => `${v} x ${v}`,
  },
  { id: 'contourCount', labelId: 'valContourCount', fmt: (v) => `${v} lines` },
  {
    id: 'isolationRadius',
    labelId: 'valIsolationRadius',
    fmt: (v) => `${v} m`,
  },
  { id: 'idwExponent', labelId: 'valIdwExponent', fmt: (v) => v.toFixed(1) },
  {
    id: 'peakPreservation',
    labelId: 'valPeakPreservation',
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
  {
    id: 'coverageWeighting',
    labelId: 'valCoverageWeighting',
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
  {
    id: 'surfaceOpacity',
    labelId: 'valSurfaceOpacity',
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
  {
    id: 'hillshadeStrength',
    labelId: 'valHillshadeStrength',
    fmt: (v) => `${Math.round(v * 100)}%`,
  },
];

export const GRAPH_BAND_TOGGLE_DEFS = [
  { id: 'showOsmGraphBands', stateKey: 'showOsmContext' },
  { id: 'showNdviGraphBands', stateKey: 'showNdviContext' },
  { id: 'showEmFogGraphBands', stateKey: 'showEmFogContext' },
];
