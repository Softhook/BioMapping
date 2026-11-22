// GSRMapManager — the Leaflet map: GPS path, peak markers, collective
// surfaces and overlays.
//
// It is one chain of classes, one file per job, each extending the one
// before it (class names follow the file: map_base.mjs is GSRMapBase,
// manager/layers.mjs is GSRMapLayers, and so on):
//   map_base.mjs                the Leaflet map, basemap, shared state
//   manager/layers.mjs          per-track layer ownership, clearMap/clearAll
//   manager/process.mjs         GPS pipeline -> drawPoints + cache
//   manager/viewport.mjs        fit / zoom / scrub position
//   manager/legend.mjs          the bottom-right legend
//   manager/osm.mjs             OSM vector overlays
//   manager/rf_fluid.mjs        RF Fluid overlay control
//   manager/path.mjs            colour-coded path segments
//   manager/peaks.mjs           peak / hotspot markers
//   manager/arousal_places.mjs  the Arousal Places layer
//   manager/collective.mjs      collective view + contours
//   manager/toggles.mjs         layer visibility toggles
//   manager/render.mjs          renderData / refreshPath / refreshPeakMarkers
// A method may call one defined further down the chain; GSRMapBase has empty
// stubs for the few it calls itself.

import { GSRMapRender } from './manager/render.mjs';

export class GSRMapManager extends GSRMapRender {}
