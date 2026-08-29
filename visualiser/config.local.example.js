// Local, machine-specific overrides. Copy to config.local.js (gitignored):
//
//   cp config.local.example.js config.local.js
//
// config.js pulls this in automatically, but ONLY on a local origin (file://
// or localhost) — the hosted site never loads it. It runs after config.js, so
// values set here win.
//
// Alternative for just the CARTO key, no file needed — run once in the
// browser console:
//   localStorage.setItem('bioMappingCartoApiKey', 'YOUR_KEY')

window.BIOMAP_CONFIG = Object.assign(window.BIOMAP_CONFIG || {}, {
  // cartoApiKey: 'YOUR_DEV_KEY',
});
