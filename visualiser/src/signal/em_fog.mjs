/**
 * EM Fog Index (0-100) from RSSI readings across Sub-GHz bands.
 * Single source of truth for both GSRAnalyzer.calcEmFog (kept as a thin
 * delegate for API compatibility) and GSRCSVParser.parse()'s dynamic
 * EM-fog fallback — pulled out to a leaf module so the parser doesn't
 * need to import the analyzer class to reach it.
 */

export const DEFAULT_FLOOR_DBM = -100.0;
export const SATURATION_CEILING_DBM = -30.0;

export const SUB_GHZ_BANDS = [
  { prop: 'rssi_300', key: '300' },
  { prop: 'rssi_315', key: '315' },
  { prop: 'rssi_434', key: '434' },
  { prop: 'rssi_446', key: '446' },
  { prop: 'rssi_815', key: '815' },
  { prop: 'rssi_868', key: '868' },
  { prop: 'rssi_915', key: '915' },
];

/**
 * Normalizes an RSSI dBm reading between floor and saturation ceiling into [0.0, 1.0].
 */
export function normalizeBandRssi(rssi, floor = DEFAULT_FLOOR_DBM) {
  const fraction = (rssi - floor) / (SATURATION_CEILING_DBM - floor);
  return Math.min(1.0, Math.max(0.0, fraction));
}

export function calcEmFog(row, bandFloors = null) {
  const floors = bandFloors || row?.bandFloors || null;
  let sumPsq = 0;
  let cnt = 0;

  for (let i = 0; i < SUB_GHZ_BANDS.length; i++) {
    const band = SUB_GHZ_BANDS[i];
    const v = row[band.prop];
    if (typeof v === 'number' && !isNaN(v)) {
      const floor =
        floors && typeof floors[band.key] === 'number'
          ? floors[band.key]
          : DEFAULT_FLOOR_DBM;
      const norm = normalizeBandRssi(v, floor);
      sumPsq += norm * norm;
      cnt++;
    }
  }

  return cnt > 0 ? Math.sqrt(sumPsq / cnt) * 100.0 : NaN;
}
