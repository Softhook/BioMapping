/**
 * Time / date formatting for the GSR analyser — extracted from analyzer.js.
 *
 * Every function takes `recordingStartTime` (Unix seconds, or 0/small when the
 * CSV carried no real start clock) as its first argument and is otherwise pure.
 * GSRAnalyzer keeps thin instance wrappers (`formatClockTime`, `formatTimeOnly`,
 * `formatDateUK`, `formatDateShort`) that pass `this.recordingStartTime` through.
 */

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** Zero-pads an integer to at least two digits. */
function pad2(num) {
  return String(num).padStart(2, '0');
}

export const AnalyzerTimeFormat = {
  /**
   * True when session-relative time should be shown instead of wall-clock time
   * — i.e. no real recording start was restored from the CSV.
   * @param {number} recordingStartTime - Unix seconds, or 0/small if absent
   * @returns {boolean}
   */
  isRelative(recordingStartTime) {
    return !recordingStartTime || recordingStartTime < 86400;
  },

  /**
   * Ordinal suffix for a day-of-month (1 -> "st", 2 -> "nd", 3 -> "rd", else
   * "th"), skipping the English teens (11/12/13).
   * @param {number} day - Day of month, 1-31
   * @returns {string}
   */
  ordinalSuffix(day) {
    if (day % 100 >= 11 && day % 100 <= 13) return 'th';
    const rem = day % 10;
    if (rem === 1) return 'st';
    if (rem === 2) return 'nd';
    if (rem === 3) return 'rd';
    return 'th';
  },

  /**
   * Clock time for a relative offset. Relative mode: "M:SS" (or "H:MM:SS" over
   * an hour). Absolute mode: UTC "HH:MM:SS" from recordingStartTime.
   * @param {number} recordingStartTime - Unix seconds
   * @param {number} relativeSeconds - Seconds from recording start
   * @returns {string}
   */
  clockTime(recordingStartTime, relativeSeconds) {
    if (AnalyzerTimeFormat.isRelative(recordingStartTime)) {
      const totalSec = Math.round(relativeSeconds);
      const h = Math.floor(totalSec / 3600);
      const m = Math.floor((totalSec % 3600) / 60);
      const s = totalSec % 60;
      return h > 0 ? `${h}:${pad2(m)}:${pad2(s)}` : `${m}:${pad2(s)}`;
    }

    const d = new Date((recordingStartTime + relativeSeconds) * 1000);
    return `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
  },

  /**
   * UK-formatted date, e.g. "30th Dec 2026". Falls back to clockTime() in
   * relative mode.
   * @param {number} recordingStartTime - Unix seconds
   * @param {number} relativeSeconds - Seconds from recording start
   * @returns {string}
   */
  dateUK(recordingStartTime, relativeSeconds) {
    if (AnalyzerTimeFormat.isRelative(recordingStartTime)) {
      return AnalyzerTimeFormat.clockTime(recordingStartTime, relativeSeconds);
    }

    const d = new Date((recordingStartTime + relativeSeconds) * 1000);
    const day = d.getUTCDate();
    const month = MONTH_NAMES[d.getUTCMonth()];
    const year = d.getUTCFullYear();

    return `${day}${AnalyzerTimeFormat.ordinalSuffix(day)} ${month} ${year}`;
  },

  /**
   * Short numeric date, e.g. "30.12.2026". Falls back to clockTime() in
   * relative mode.
   * @param {number} recordingStartTime - Unix seconds
   * @param {number} relativeSeconds - Seconds from recording start
   * @returns {string}
   */
  dateShort(recordingStartTime, relativeSeconds) {
    if (AnalyzerTimeFormat.isRelative(recordingStartTime)) {
      return AnalyzerTimeFormat.clockTime(recordingStartTime, relativeSeconds);
    }

    const d = new Date((recordingStartTime + relativeSeconds) * 1000);
    const day = pad2(d.getUTCDate());
    const month = pad2(d.getUTCMonth() + 1);
    const year = d.getUTCFullYear();

    return `${day}.${month}.${year}`;
  },
};
