/**
 * BioMapping 2.0 - 3D Globe Manager (CesiumJS)
 * Copyright (c) 2026 Christian Nold
 * Licensed under the Bio Mapping Community Licence 1.0.
 *
 * Renders biometric tracks as 3D extruded emotional ribbons/walls and
 * vertical peak spires over 3D terrain and satellite/urban basemaps.
 *
 * GSRGlobeManager is a self-contained, embeddable engine: construct it against a
 * container id, feed it an analysed track via renderData({ drawPoints }), and
 * tear it down with destroy(). It makes no assumptions about owning the whole
 * page — index.html's 3D-surface panel is the host (see src/map/globe3d_view.js).
 * Page chrome (sidebar, help pill) lives in the host, never here. The host always
 * supplies the display points; this class never runs the GPS filter chain.
 */

import { GSRGlobeTour } from './globe3d/tour.mjs';

// Basemap URL resolution: GSRBasemap.cartoTileUrl (delegated to globe3d_base.mjs)

export {
  BASEMAP_PROVIDERS,
  GSRGlobeBase,
  HEIGHT_CAPABLE_METRICS,
  SERIES_FIELD,
  seriesValue,
} from './globe3d/globe3d_base.mjs';
export { GSRGlobeNavigation } from './globe3d/navigation.mjs';
export { GSRGlobeOsm } from './globe3d/osm.mjs';
export { GSRGlobePeaks } from './globe3d/peaks.mjs';
export { GSRGlobeRf } from './globe3d/rf.mjs';
export { GSRGlobeToggles } from './globe3d/toggles.mjs';
export { GSRGlobeTour } from './globe3d/tour.mjs';

export class GSRGlobeManager extends GSRGlobeTour {}
