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
 * page — index.html's 3D-surface panel is the host (see src/map/globe3d_view.mjs).
 * Page chrome (sidebar, help pill) lives in the host, never here. The host always
 * supplies the display points; this class never runs the GPS filter chain.
 */

// Like the 2D map (map.mjs), it is one chain of classes, each extending the
// one before it (globe3d/osm.mjs is GSRGlobeOsm, and so on):
//   globe3d/globe3d_base.mjs  viewer, basemaps, track ribbon, camera
//   globe3d/osm.mjs           3D OSM buildings (geometry in buildings.mjs)
//   globe3d/rf.mjs            RF expanse (geometry in rf_expanse.mjs)
//   globe3d/peaks.mjs         peak spires, hotspots, cluster ground blobs
//   globe3d/toggles.mjs       layer visibility toggles + entity clearing
//   globe3d/navigation.mjs    fly-to / focus + turntable orbit
//   globe3d/hotspot_tour.mjs  hotspot-to-hotspot tour
//   globe3d/replay_tour.mjs   the walk redrawn at sped-up real time
//   globe3d/tour.mjs          shared tour controls
// 3D track export (CZML / KML) is in globe3d/exporters.mjs, driven from the
// main Export Options panel; it needs no live viewer.

import { GSRGlobeTour } from './globe3d/tour.mjs';

export {
  BASEMAP_PROVIDERS,
  SERIES_FIELD,
  seriesValue,
} from './globe3d/globe3d_base.mjs';

export class GSRGlobeManager extends GSRGlobeTour {}
