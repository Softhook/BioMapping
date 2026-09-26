/**
 * Loads one src/ ES module and copies every export onto `global`, for the
 * lightweight (non-jsdom) test files and manual scripts that don't boot the
 * full app via boot_app.js but still read modules back as bare globals
 * (e.g. `global.GSRAnalyzer`).
 *
 * Synchronous on purpose: Node can require() an ES module with no top-level
 * await, and callers use this at plain module top level (some aren't
 * node:test files at all), so staying synchronous keeps every caller simple.
 */
function loadModule(filePath) {
  Object.assign(global, require(filePath));
}

module.exports = { loadModule };
