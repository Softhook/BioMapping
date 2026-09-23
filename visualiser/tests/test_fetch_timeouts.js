/**
 * Tile fetches carry a timeout, so a tile server that accepts the connection
 * and then never answers can't hang an SVG export or leave an NDVI tile
 * loading forever. AbortSignal.timeout is swapped for a signal the test
 * fires by hand, so nothing waits the real 20–30 s.
 */
const assert = require('node:assert');
const test = require('node:test');

global.GSR_CONST = require('./mock_constants.js');
const { GSRMapExporter } = require('../src/map/map_exporter.mjs');
const { GSRMapOsm } = require('../src/map/manager/osm.mjs');
const { NDVISampler } = require('../src/osm/ndvi_sampler.mjs');
const { GSRNotices } = require('../src/core/notices.mjs');

// A server that never answers: the fetch settles only when its signal aborts.
function installStalledServer() {
  const ctl = new AbortController();
  const seen = { timeoutMs: null, fetches: 0 };
  const saved = {
    fetch: global.fetch,
    timeout: AbortSignal.timeout,
    document: global.document,
    report: GSRNotices.report,
  };
  AbortSignal.timeout = (ms) => {
    seen.timeoutMs = ms;
    return ctl.signal;
  };
  global.fetch = (_url, opts = {}) => {
    seen.fetches++;
    return new Promise((_resolve, reject) => {
      opts.signal?.addEventListener('abort', () =>
        reject(new DOMException('timed out', 'TimeoutError')),
      );
    });
  };
  GSRNotices.report = () => {};
  const restore = () => {
    global.fetch = saved.fetch;
    AbortSignal.timeout = saved.timeout;
    global.document = saved.document;
    GSRNotices.report = saved.report;
  };
  return { fire: () => ctl.abort(), seen, restore };
}

test('SVG export: a stalled tile server gives up (tile skipped) instead of hanging', async () => {
  const server = installStalledServer();
  try {
    // Cross-origin tile: the canvas shortcut is tainted, so it must fetch.
    global.document = {
      createElement: () => ({
        getContext: () => ({ drawImage() {} }),
        toDataURL() {
          throw new Error('tainted canvas');
        },
      }),
    };
    const img = { getAttribute: () => 'https://tiles.example/1/2/3.png' };

    const pending = GSRMapExporter._inlineImg(img);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(server.seen.fetches, 1);
    assert.strictEqual(server.seen.timeoutMs, 20000);

    server.fire();
    assert.strictEqual(await pending, null);
  } finally {
    server.restore();
  }
});

test('NDVI map layer: a stalled tile fetch ends with an error, not a tile stuck loading', async () => {
  const server = installStalledServer();
  const savedL = global.L;
  const savedSampler = { ...NDVISampler };
  try {
    global.document = {
      createElement: () => ({ getContext: () => ({}) }),
    };
    let spec = null;
    global.L = {
      TileLayer: {
        extend(s) {
          spec = s;
          return function Layer() {
            this.addTo = () => this;
            this.on = () => this;
          };
        },
      },
    };
    Object.assign(NDVISampler, {
      hasCopernicusConfig: () => true,
      buildRawTileUrl: () => 'https://sh.example/tile',
      _getTileCache: () => null,
    });
    const mgr = {
      map: { getPane: () => ({}) },
      hideNdviLayer() {},
    };
    GSRMapOsm.prototype.showNdviLayer.call(mgr);
    assert.ok(spec?.createTile, 'raw NDVI layer was built');

    let result = null;
    spec.createTile({ x: 1, y: 2, z: 3 }, (err, tile) => {
      result = { err, tile };
    });
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(server.seen.timeoutMs, 30000);
    assert.strictEqual(result, null, 'still waiting on the server');

    server.fire();
    await new Promise((r) => setImmediate(r));
    assert.ok(result?.err, 'tile reported as failed');
  } finally {
    server.restore();
    global.L = savedL;
    Object.assign(NDVISampler, savedSampler);
  }
});
