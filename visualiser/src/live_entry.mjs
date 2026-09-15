/**
 * live.html's real entry point — the browser-side counterpart of
 * tests/support/boot_live.js's LIVE_SCRIPT_ORDER (kept in sync with it by
 * tests/test_script_order.js; the two must list the same 20 files, in the
 * same order — see src/app_entry.mjs's own header comment for why order
 * itself isn't load-bearing under real ES modules).
 *
 * Unlike app_entry.mjs, nothing here needs to escape onto `window` — this
 * module IS the orchestration live.html used to do inline (`GSRLiveView
 * .mount(document.getElementById('liveRoot'))`), so it just imports
 * GSRLiveView directly and calls it itself.
 */
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
