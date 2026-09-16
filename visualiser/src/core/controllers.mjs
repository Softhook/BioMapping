/**
 * Cross-module singleton registry for the UI/wiring layer.
 *
 * `ui.mjs`, `events.mjs`, `tracks.mjs`, `collective_project.mjs`,
 * `storage.mjs`, `map_popups.mjs`, `globe3d_view.mjs`, and `sketch.mjs` all
 * call methods on each other's exported singleton objects (GSRUI, GSREvents,
 * GSRTrackManager, GSRCollectiveProject), but only ever from inside function
 * bodies that run after every module has finished loading — never at
 * module-eval time. Importing each other directly therefore worked (ES
 * module live bindings tolerate cycles as long as nothing is touched at eval
 * time) but produced a mutually-referential import clique that couldn't be
 * understood file-by-file.
 *
 * Each singleton registers itself here immediately after its own
 * module-level definition; everything else in the clique looks its siblings
 * up through this leaf module (no imports of its own) instead of importing
 * each other directly, which keeps the import graph acyclic while leaving
 * the runtime call graph — and every call site's behaviour — unchanged.
 */
export const Controllers = {
  ui: undefined,
  events: undefined,
  trackManager: undefined,
  collectiveProject: undefined,
  liveView: undefined,
};
