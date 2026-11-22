/**
 * live.html's entry point. Imports the same modules, in the same order, as
 * LIVE_SCRIPT_ORDER in tests/support/boot_live.js (tests/test_html_wiring.js
 * checks the two lists match; app_entry.mjs says why the order is kept), then
 * mounts GSRLiveView. Unlike app_entry.mjs, nothing needs to go on `window`.
 */
import './core/notices.mjs';
import './core/constants.mjs';
import './signal/gsr_filter.mjs';
import './signal/deconvolution.mjs';
import './signal/spectral_eda.mjs';
import './signal/analyzer_time_format.mjs';
import './signal/analyzer.mjs';
import './map/basemap.mjs';
import './map/map_colors.mjs';
import './gps/gps_pipeline.mjs';
import './core/file_saver.mjs';
import './live/live_binary_parser.mjs';
import './live/live_state.mjs';
import './live/live_bluetooth.mjs';
import './live/live_csv.mjs';
import './live/live_tile_cache.mjs';
import './live/live_graph.mjs';
import './live/live_map.mjs';
import './core/fullscreen.mjs';
import './map/map_markers.mjs';
import './live/live_view.mjs';

import { GSRLiveView } from './live/live_view.mjs';

GSRLiveView.mount(document.getElementById('liveRoot'));
