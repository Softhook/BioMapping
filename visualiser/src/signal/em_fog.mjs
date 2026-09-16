/**
 * EM Fog Index (0-100) from RSSI readings across Sub-GHz bands.
 * Single source of truth for both GSRAnalyzer.calcEmFog (kept as a thin
 * delegate for API compatibility) and GSRCSVParser.parse()'s dynamic
 * EM-fog fallback — pulled out to a leaf module so the parser doesn't
 * need to import the analyzer class to reach it.
 */
const BANDS = [
  'rssi_300',
  'rssi_315',
  'rssi_434',
  'rssi_446',
  'rssi_815',
  'rssi_868',
  'rssi_915',
];

export function calcEmFog(row, bandFloors = null) {
  const floors = bandFloors || row?.bandFloors || null;
  let sumPsq = 0,
    cnt = 0;
  for (let i = 0; i < BANDS.length; i++) {
    const v = row[BANDS[i]];
    if (typeof v === 'number' && !isNaN(v)) {
      const bandKey = BANDS[i].replace('rssi_', '');
      const floor =
        floors && typeof floors[bandKey] === 'number'
          ? floors[bandKey]
          : -100.0;
      const norm = Math.min(1.0, Math.max(0.0, (v - floor) / (-30.0 - floor)));
      sumPsq += norm * norm;
      cnt++;
    }
  }
  return cnt > 0 ? Math.sqrt(sumPsq / cnt) * 100.0 : NaN;
}
