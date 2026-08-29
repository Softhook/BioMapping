// Deployed runtime config for the visualiser — committed and served with the
// site. Loaded by index.html and live.html before any app code.

window.BIOMAP_CONFIG = {
  // CARTO raster basemap key — free, 5M tiles/month: https://carto.com/basemaps/apikey/
  //
  // This string ships in page source (unavoidable for any client-side map
  // key), so LOCK IT to your domains in the CARTO dashboard under "Allowed
  // referrers", e.g.
  //   https://<you>.github.io/*
  //   http://localhost:*/*        (for local dev)
  // A domain-locked key is useless to anyone who copies it off the page.
  //
  // Empty string: tiles still load, but every one carries an
  // "API key required" watermark.
  cartoApiKey: '',
};

// Local dev only: layer config.local.js (gitignored, never deployed) on top of
// the above. Gated on a local origin so the hosted site never requests it and
// visitors get no 404. See config.local.example.js.
(function () {
  var h = location.hostname;
  var local = location.protocol === 'file:' ||
    h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '[::1]';
  if (local && document.readyState === 'loading') {
    document.write('<script src="config.local.js"><\/script>');
  }
})();
