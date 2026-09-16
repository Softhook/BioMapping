/**
 * dependency-cruiser config — see docs/visualiser_architecture_review_2026-09-16.md
 * for the audit that motivated this. Run via `npm run lint:deps`.
 */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'Circular imports make a module impossible to understand in isolation. ' +
        'If you hit this, either invert the dependency (callback/registration ' +
        'instead of a mutual import) or route the shared reference through ' +
        'core/controllers.mjs the way ui.mjs/events.mjs/tracks.mjs/ ' +
        'collective_project.mjs do.',
      from: {},
      to: { circular: true },
    },
    {
      name: 'no-ui-imports-in-signal-gps-osm',
      severity: 'error',
      comment:
        'signal/, gps/, and osm/ are the DOM-free analysis layers — keeping ' +
        'them free of ui/map/render/live imports is what lets them run ' +
        'standalone in tests. See docs/visualiser_architecture_review_2026-09-16.md.',
      from: { path: '^src/(signal|gps|osm)/' },
      to: { path: '^src/(ui|map|render|live)/' },
    },
  ],
  options: {
    doNotFollow: { path: 'node_modules' },
    tsPreCompilationDeps: false,
    includeOnly: '^src',
    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default'],
    },
  },
};
