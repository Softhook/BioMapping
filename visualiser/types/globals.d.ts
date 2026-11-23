// What the page provides outside src/: the libraries index.html and
// live.html load with <script> tags (vendor/), Cesium loaded on demand by
// the 3D view, Web Bluetooth, and config.js. Read by the type checker only
// (tsconfig.json); the browser never loads this file. The type packages are
// the versions in vendor/ (package.json devDependencies).

/// <reference types="leaflet" />
/// <reference types="p5/global" />
/// <reference types="web-bluetooth" />

import type * as CesiumEngine from '@cesium/engine';
import type * as CesiumWidgets from '@cesium/widgets';
import type JSZipType from 'jszip';

declare global {
  /** vendor/cesium/Cesium.js: engine and widgets in one global. */
  const Cesium: typeof CesiumEngine & typeof CesiumWidgets;
  const JSZip: typeof JSZipType;

  interface Window {
    /** config.js (and config.local.js when run locally). */
    BIOMAP_CONFIG: {
      cartoApiKey?: string;
      cesiumIonToken?: string;
      copernicusInstanceId?: string;
      copernicusRawLayerId?: string;
      copernicusTimeRange?: string;
      [key: string]: unknown;
    };
    /** Set once vendor/cesium/Cesium.js has loaded. */
    Cesium?: typeof CesiumEngine & typeof CesiumWidgets;
    /** Where Cesium.js finds its workers and assets (globe3d_view.mjs). */
    CESIUM_BASE_URL?: string;
    /** ui/ui.mjs: for the inline on*= handlers in generated table HTML. */
    GSRUI?: unknown;
    /** File System Access API (Chromium only); core/file_saver.mjs checks for it. */
    showSaveFilePicker?: (options?: {
      suggestedName?: string;
      types?: Array<{ description: string; accept: Record<string, string[]> }>;
    }) => Promise<FileSystemFileHandle>;
  }

  /** The code reads values that may be numbers or text through parseFloat
   * (a number comes back unchanged). */
  // biome-ignore lint/suspicious/noShadowRestrictedNames: adds a second form to the built-in parseFloat, doesn't replace it
  function parseFloat(value: string | number): number;

  /** Older browsers' prefixed fullscreen API (core/fullscreen.mjs). */
  interface Document {
    webkitFullscreenElement?: Element | null;
    mozFullScreenElement?: Element | null;
    webkitExitFullscreen?: () => Promise<void> | void;
    mozCancelFullScreen?: () => Promise<void> | void;
  }

  interface HTMLImageElement {
    /** Blob URL of a cached Live map tile, revoked when the tile goes
     * (live/live_tile_cache.mjs). */
    _objUrl?: string;
  }
}

declare module 'leaflet' {
  /** Leaflet's own factory for an empty control (not in its declarations). */
  function control(options?: ControlOptions): Control;

  namespace tileLayer {
    /** The Live map's offline-cached tile layer (live/live_tile_cache.mjs). */
    function cache(urlTemplate: string, options?: TileLayerOptions): TileLayer;
  }
  interface Layer {
    /** What a 2D map layer draws, e.g. 'collectivePath' (map/manager/). */
    _gsrKind?: string;
    /** The per-track layer group it belongs to (map/manager/layers.mjs). */
    _gsrLayerGroup?: LayerGroup;
    /** A peak marker that shows a label (map/manager/peaks.mjs). */
    hasLabel?: boolean;
  }
  interface TileLayer {
    /** Leaflet internals the cached tile layer overrides. */
    _tiles: Record<string, { el: HTMLImageElement }>;
    _removeTile(key: string): void;
  }
}

declare module '@cesium/engine' {
  interface Entity {
    /** Index into the track's peaks, on peak markers (globe3d/peaks.mjs). */
    _biomapPeakIndex?: number;
  }
}
