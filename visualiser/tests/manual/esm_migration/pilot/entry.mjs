/**
 * Pilot stand-in for the real migration's src/main.js entry point: imports
 * the app's modules so the whole graph resolves through one dynamic
 * import() call, the same shape boot_app.js's replacement will use.
 */
export { GeoUtils } from './geo_utils.mjs';
export { NoticeCore } from './notice_core.mjs';
