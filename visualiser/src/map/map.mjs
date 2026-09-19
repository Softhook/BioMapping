// Leaflet.js Map Manager for GSR + GPS Visualisation
// Handles path rendering, arousal color-coding, and peak marker overlays.

import { GSRMapRender } from './manager/render.mjs';

// Basemap URL resolution: GSRBasemap.cartoTileUrl (in map_base.mjs)

export { GSRMapArousalPlaces } from './manager/arousal_places.mjs';
export { GSRMapCollective } from './manager/collective.mjs';
export { GSRMapLayers } from './manager/layers.mjs';
export { GSRMapLegend } from './manager/legend.mjs';
export { GSRMapOsm } from './manager/osm.mjs';
export { GSRMapPath } from './manager/path.mjs';
export { GSRMapPeaks } from './manager/peaks.mjs';
export { GSRMapProcess } from './manager/process.mjs';
export { GSRMapRender } from './manager/render.mjs';
export { GSRMapRfFluid } from './manager/rf_fluid.mjs';
export { GSRMapToggles } from './manager/toggles.mjs';
export { GSRMapViewport } from './manager/viewport.mjs';
export { GSRMapBase } from './map_base.mjs';

export class GSRMapManager extends GSRMapRender {}
