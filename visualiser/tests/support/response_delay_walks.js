/**
 * Made-up walks for the Response delay tests (test_response_delay.js).
 *
 * The main one walks due east in a straight line at 1 m/s with a GPS fix on
 * every row, so "where was the walker d seconds earlier" has one exact answer
 * and every place row has a longitude no other row shares. Five clear skin
 * responses give the peak detector something to find.
 */

const EAST_M_PER_DEG = 111320 * Math.cos((51.5 * Math.PI) / 180);

/** Skin response starting at t0: fast rise, slow recovery (0 before t0). */
function response(t, t0) {
  if (t <= t0) return 0;
  const s = t - t0;
  return (1 - Math.exp(-s / 0.75)) * Math.exp(-s / 4);
}

/**
 * CSV text in the current device format.
 * @param {object} [o]
 * @param {number} [o.seconds=180]
 * @param {number} [o.hz=10]
 * @param {number} [o.warmupS=0]    - seconds at the start with no GPS fix
 * @param {number[]} [o.responsesAt] - response start times (s)
 * @param {(i:number)=>number} [o.tickDt] - adds a tick_dt_ms column
 */
function straightWalkCsv(o = {}) {
  const seconds = o.seconds ?? 180;
  const hz = o.hz ?? 10;
  const warmupS = o.warmupS ?? 0;
  const responsesAt = o.responsesAt ?? [30, 60, 90, 120, 150];
  const n = Math.round(seconds * hz);
  const cols = [
    'timestamp',
    'lat',
    'lon',
    'hdop',
    'pdop',
    'sats',
    'fix_type',
    'speed_kts',
    'course_deg',
    'gsr_raw',
    'hacc_m',
  ];
  if (o.tickDt) cols.push('tick_dt_ms');
  const lines = ['# RecordingStartTime:1785503000', cols.join(',')];
  for (let i = 0; i < n; i++) {
    const t = i / hz;
    const hasFix = t >= warmupS;
    let gsr = 5000;
    for (const t0 of responsesAt) gsr += 900 * response(t, t0);
    const row = [
      t.toFixed(2),
      hasFix ? '51.5000000' : '',
      hasFix ? (-0.1 + t / EAST_M_PER_DEG).toFixed(7) : '',
      // HDOP varies row to row, so a test can tell whether a place value
      // (like HDOP) was shifted along with the body data. It must not be.
      hasFix ? (1 + (i % 7) * 0.1).toFixed(1) : '99.9',
      hasFix ? '1.5' : '99.9',
      hasFix ? '12' : '0',
      hasFix ? '3' : '1',
      hasFix ? '1.94' : '',
      hasFix ? '90.0' : '',
      gsr.toFixed(1),
      hasFix ? '2.0' : '',
    ];
    if (o.tickDt) row.push(String(o.tickDt(i)));
    lines.push(row.join(','));
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The same walk with clock-text timestamps (the oldest device format): one
 * label per second, and an uneven number of rows in each second.
 * @returns {{csv: string, labels: number[]}} labels[i] = row i's second
 */
function isoWalkCsv() {
  const perSecond = [10, 10, 4, 12, 10, 1, 11, 10, 10, 6, 10, 10];
  const lines = ['timestamp,lat,lon,alt,sats,fix,gsr_raw'];
  const labels = [];
  const start = Date.parse('2026-07-06T19:12:00Z') / 1000;
  let k = 0;
  perSecond.forEach((count, s) => {
    for (let r = 0; r < count; r++, k++) {
      const iso = new Date((start + s) * 1000)
        .toISOString()
        .replace('.000', '');
      lines.push(
        [
          iso,
          '51.5',
          (-0.1 + k * 1e-5).toFixed(7),
          '10',
          '8',
          '1',
          '5000',
        ].join(','),
      );
      labels.push(s);
    }
  });
  return { csv: `${lines.join('\n')}\n`, labels };
}

module.exports = { straightWalkCsv, isoWalkCsv, EAST_M_PER_DEG };
