/**
 * index.html's real entry point — the browser-side counterpart of
 * tests/support/boot_app.js's SCRIPT_ORDER (kept in sync with it by
 * tests/test_script_order.js; the two must list the same 93 files, in the
 * same order).
 *
 * Every file below is imported purely for its own top-level side effect
 * (an `Object.assign(GSRMapManager.prototype, __methods)`-style composition,
 * or a class/const declaration another file reaches via its own `import`) —
 * nothing here is a dependency of THIS file. Static imports are hoisted and
 * executed in real dependency order by the module graph regardless of the
 * order they're listed in below (ESM, unlike the old `<script>`-tag list,
 * resolves the graph itself) — this order is kept the same as SCRIPT_ORDER
 * purely for easy diffing against it, not because it's load-bearing here.
 *
 * Two names need to escape this module's scope, because their consumers are
 * NOT other ES modules:
 *  - p5.js's "global mode" auto-detects `window.setup`/`window.draw`/etc. as
 *    bare properties of `window` — sketch.mjs exports these as ordinary
 *    named exports (module-scoped, not on `window`, under real ESM), so
 *    they're re-exposed explicitly below.
 *  - GSRUI is called from a handful of inline `onclick="GSRUI.foo()"`
 *    attributes still in index.html's markup (modal close buttons etc.) —
 *    inline event-handler attributes execute in the global scope, which a
 *    module's top-level bindings never reach automatically either.
 */
import './core/notices.mjs';
import './core/app_state.mjs';
import './core/fullscreen.mjs';
import './core/layout_manager.mjs';
import './core/constants.mjs';
import './gps/geo_utils.mjs';
import './spatial/spatial_grid.mjs';
import './core/file_saver.mjs';
import './signal/stats_math.mjs';
import './osm/overpass_client.mjs';
import './osm/osm_cache.mjs';
import './signal/dwt_filter.mjs';
import './signal/deconvolution.mjs';
import './signal/cvxeda.mjs';
import './signal/csv_parser.mjs';
import './signal/spectral_eda.mjs';
import './signal/analyzer_time_format.mjs';
import './signal/response_dynamics.mjs';
import './signal/analyzer.mjs';
import './osm/osm_enrichment.mjs';
import './osm/ndvi_sampler.mjs';
import './gps/map_match.mjs';
import './signal/gsr_filter.mjs';
import './render/marching_squares.mjs';
import './map/hillshade.mjs';
import './spatial/spatial_clustering.mjs';
import './spatial/arousal_places.mjs';
import './spatial/collective_manager.mjs';
import './gps/gps_filter.mjs';
import './map/basemap.mjs';
import './map/map_colors.mjs';
import './gps/gps_pipeline.mjs';
import './map/map_markers.mjs';
import './live/live_binary_parser.mjs';
import './live/live_state.mjs';
import './live/live_bluetooth.mjs';
import './live/live_csv.mjs';
import './live/live_tile_cache.mjs';
import './live/live_graph.mjs';
import './live/live_map.mjs';
import './live/live_view.mjs';
import './render/label_placement.mjs';
import './render/bezier_spline.mjs';
import './render/contour_ring_geometry.mjs';
import './map/map_exporter.mjs';
import './render/rf_fluid_renderer.mjs';
import './map/map_popups.mjs';
import './map/map.mjs';
import './map/manager/process.mjs';
import './map/manager/legend.mjs';
import './map/manager/layers.mjs';
import './map/manager/osm.mjs';
import './map/manager/rf_fluid.mjs';
import './map/manager/viewport.mjs';
import './map/manager/render.mjs';
import './map/manager/path.mjs';
import './map/manager/peaks.mjs';
import './map/manager/arousal_places.mjs';
import './map/manager/collective.mjs';
import './map/manager/toggles.mjs';
import './map/globe3d/exporters.mjs';
import './map/globe3d/rf_expanse.mjs';
import './map/globe3d/buildings.mjs';
import './map/globe3d.mjs';
import './map/globe3d/osm.mjs';
import './map/globe3d/rf.mjs';
import './map/globe3d/peaks.mjs';
import './map/globe3d/toggles.mjs';
import './map/globe3d/navigation.mjs';
import './map/globe3d/tour.mjs';
import './map/globe3d_view.mjs';
import './ui/storage.mjs';
import './ui/events.mjs';
import './ui/events_gsr_analysis.mjs';
import './ui/events_timeline.mjs';
import './ui/events_file_export.mjs';
import './ui/events_gps.mjs';
import './ui/events_map_panel.mjs';
import './ui/events_presets.mjs';
import './ui/events_enrichment.mjs';
import './ui/events_environmental_dashboard.mjs';
import './ui/events_view_switcher.mjs';
import './ui/events_surface_switcher.mjs';
import './ui/tracks.mjs';
import './spatial/collective_project.mjs';
import './ui/ui.mjs';
import './ui/ui_peaks_table.mjs';
import './ui/ui_stats_panel.mjs';
import './ui/ui_collective_map.mjs';
import './ui/ui_export.mjs';
import './ui/ui_osm_overlay.mjs';
import './ui/ui_enrichment.mjs';
import './ui/ui_correlation_table.mjs';
import './ui/ui_road_profile.mjs';
import './ui/ui_environmental_dashboard.mjs';
import './ui/ui_modals.mjs';
import './render/renderer.mjs';
import './render/renderer_bands.mjs';
import './render/renderer_curve.mjs';
import './render/renderer_markers.mjs';
import './render/renderer_interaction.mjs';
import './render/renderer_chrome.mjs';
import './render/sketch.mjs';

import {
  draw,
  mouseDragged,
  mouseMoved,
  mousePressed,
  mouseReleased,
  mouseWheel,
  setup,
  windowResized,
} from './render/sketch.mjs';
import { GSRUI } from './ui/ui.mjs';

Object.assign(window, {
  setup,
  draw,
  windowResized,
  mousePressed,
  mouseDragged,
  mouseReleased,
  mouseMoved,
  mouseWheel,
  GSRUI,
});
