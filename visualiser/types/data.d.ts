// The visualiser's main data shapes, for the type checker (tsconfig.json).
// Global: JSDoc anywhere in src/ can name them, e.g. `@param {GSRRow} row`.
// The browser never loads this file.

/** One recording row, as GSRCSVParser builds it (signal/csv_parser.mjs). */
interface GSRRow {
  /** Seconds from the recording start. */
  time: number;
  /** Skin conductance, µS. */
  val: number;
  lat: number;
  lon: number;
  hdop: number;
  pdop: number;
  /** The GPS's own accuracy estimate, metres (NaN when absent). */
  hacc: number;
  sats: number;
  fixType: number;
  speedKts: number;
  course: number;
  hasGps: boolean;
  _isGpsFix: boolean;
  rssi_815: number;
  rssi_868: number;
  rssi_915: number;
  em_fog: number;
  /** The recording's per-band radio noise floors, shared by every row. */
  bandFloors: Record<string, number> | null;
  osm_road_class: string | null;
  osm_dist_major_road: number;
  osm_in_park: number;
  osm_green_pct_50m: number;
  osm_dist_green: number;
  osm_canopy_pct_50m: number;
  osm_building_density_50m: number;
  osm_dist_water: number;
  osm_tree_density_50m: number;
  osm_amenity_count_50m: number;
  ndvi: number;
  ndvi_50m: number;
}

/** A detected skin response (signal/peak_shape.mjs buildPeakObject, then
 * scored and labelled by the analyzer). */
interface GSRPeak {
  /** Sample index of the top of the response. */
  index: number;
  time: number;
  value: number;
  amplitude: number;
  onsetIndex: number;
  onsetTime: number;
  onsetValue: number;
  recoveryIndex: number;
  halfRecoveryTime: number;
  riseTime: number;
  onsetSlope: number;
  decaySlope: number;
  skewnessRatio: number;
  snr: number;
  label: string;
  excluded: boolean;
  qualityScore?: number;
  salienceScore?: number;
  possibleArtefact?: boolean;
  /** Rise Speed label, from the measured rise time. */
  speedLabel?: string;
  speedRiseTime?: number;
  scaleFactor?: number;
  bandIdx?: number;
  prominence?: number;
}

/** Analysis settings (GSR_CONST.GSR_DEFAULT's shape), plus options only
 * the tests set. */
type GSRParams =
  typeof import('../src/core/constants.mjs').GSR_CONST.GSR_DEFAULT & {
    /** Smoothing filter: 'box' (moving average) or Butterworth (default). */
    lpfMethod?: string;
    /** Butterworth cut-off, Hz; by default worked out from lpfWindow. */
    lpfCutoff?: number;
    /** Overrides GSR_CONST.SCRF.deconvAlgorithm. */
    deconvAlgorithm?: string;
  };

/** GPS filter settings (GSR_CONST.GPS_DEFAULT's shape). downsample is
 * false/true by default, 0/1 when read from the slider. */
type GSRGpsParams = Omit<
  typeof import('../src/core/constants.mjs').GSR_CONST.GPS_DEFAULT,
  'downsample'
> & { downsample: boolean | number };

/** A position. */
interface LatLon {
  lat: number;
  lon: number;
}

/** A SparsEDA driver impulse (GSRAnalyzer.phasicDriverPeaks). */
interface GSRDriverPeak {
  index: number;
  time: number;
  amplitude: number;
  /** Its bump's height in signal units, summed over the bands. */
  height: number;
  onsetSec: number;
  /** Per-band coefficients; null when the solver gave none. */
  bandAmps: number[] | null;
  bandIdx: number;
  durationScale: number;
  scaleFactor: number;
  speedLabel: string;
}

/** A GPS fix taken from a row (GpsPipeline.collectFixes). */
interface GSRFix {
  lat: number;
  lon: number;
  time: number;
  hdop: number;
  pdop: number;
  hacc: number;
  speedKts: number;
  course: number;
  fixType: number;
  /** Index of the row it came from. */
  origIdx: number;
}

/** A road-snapped position (gps/map_match.mjs); NaN lat/lon where a row
 * has none. */
interface GSRSnapPoint {
  lat: number;
  lon: number;
  roadLat?: number;
  roadLon?: number;
  alpha?: number;
  wayId?: number | string;
  dist?: number;
}
