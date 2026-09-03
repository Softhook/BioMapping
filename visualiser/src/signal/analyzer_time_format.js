/**
 * Time / date formatting for the GSR analyser — extracted from analyzer.js.
 *
 * Every function takes `recordingStartTime` (Unix seconds, or 0/small when the
 * CSV carried no real start clock) as its first argument and is otherwise pure.
 * GSRAnalyzer keeps thin instance wrappers (`formatClockTime`, `formatTimeOnly`,
 * `formatDateUK`, `formatDateShort`) that pass `this.recordingStartTime` through.
 */
const AnalyzerTimeFormat = {

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
    if (day % 10 === 1 && day !== 11) return 'st';
    if (day % 10 === 2 && day !== 12) return 'nd';
    if (day % 10 === 3 && day !== 13) return 'rd';
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
      return h > 0
        ? h + ':' + String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
        : m + ':' + String(s).padStart(2, '0');
    }

    const d = new Date((recordingStartTime + relativeSeconds) * 1000);
    return String(d.getUTCHours()).padStart(2, '0') + ':' +
           String(d.getUTCMinutes()).padStart(2, '0') + ':' +
           String(d.getUTCSeconds()).padStart(2, '0');
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
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                    'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const day = d.getUTCDate();
    const month = months[d.getUTCMonth()];
    const year = d.getUTCFullYear();

    return day + AnalyzerTimeFormat.ordinalSuffix(day) + ' ' + month + ' ' + year;
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
    const day = String(d.getUTCDate()).padStart(2, '0');
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    const year = d.getUTCFullYear();

    return day + '.' + month + '.' + year;
  }
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { AnalyzerTimeFormat };
}
if (typeof window !== 'undefined') {
  window.AnalyzerTimeFormat = AnalyzerTimeFormat;
}
