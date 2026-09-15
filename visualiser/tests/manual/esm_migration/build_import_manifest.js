/**
 * ES-module migration tooling (docs/visualizer_modularity_plan.md's "drop
 * dual-mode for real ES modules" follow-up). For every file in
 * boot_app.js's SCRIPT_ORDER, this:
 *
 *   1. Parses the file and finds every top-level declared name (the file's
 *      "export candidates" once it becomes a real module).
 *   2. Uses eslint-scope's real scope analysis (not a regex heuristic) to
 *      find every identifier the file references but never declares itself
 *      — i.e. what it currently relies on the shared browser/vm global scope
 *      to resolve.
 *   3. Cross-references (2) against every file's (1) to propose, per file,
 *      which name should be imported from which other file.
 *
 * Output is a manifest for HUMAN REVIEW before any file is actually
 * converted — not applied automatically. Two failure modes are flagged
 * loudly rather than silently guessed at: a name matching declarations in
 * more than one file (ambiguous — same name reused in unrelated files), and
 * a name matching no declaration anywhere (likely a missing entry in
 * KNOWN_GLOBALS below, not a real cross-file dependency).
 *
 * Run: node tests/manual/esm_migration/build_import_manifest.js
 */

const fs = require('node:fs');
const path = require('node:path');
const espree = require('espree');
const eslintScope = require('eslint-scope');
const { topLevelDeclaredNames } = require('./lib/top_level_names.js');

const APP_DIR = path.join(__dirname, '..', '..', '..');
const { SCRIPT_ORDER } = require('../../support/boot_app.js');

const PARSE_OPTIONS = {
  ecmaVersion: 2022,
  sourceType: 'script',
  loc: true,
  range: true,
};

// p5 "global mode" names, copied verbatim from boot_app.js's
// P5_GLOBAL_NAMES/P5_CONSTANTS (not re-derived — that list was itself
// grepped from source once; duplicating the grep here could drift).
const P5_GLOBAL_NAMES = [
  'background',
  'beginShape',
  'color',
  'constrain',
  'curveVertex',
  'endShape',
  'fill',
  'line',
  'noFill',
  'noLoop',
  'noStroke',
  'push',
  'pop',
  'rect',
  'redraw',
  'resizeCanvas',
  'stroke',
  'strokeWeight',
  'text',
  'textAlign',
  'textSize',
  'textStyle',
  'vertex',
  'loop',
  // found by build_import_manifest.js's first run — real p5 global-mode
  // names/properties boot_app.js's stub list didn't need but renderer_*.js
  // genuinely references bare: canvas dimensions/mouse state, remaining
  // drawing primitives, and the raw p5.Renderer escape hatch.
  'saveCanvas',
  'drawingContext',
  'winMouseX',
  'winMouseY',
  'mouseX',
  'mouseY',
  'map',
  'circle',
  'textWidth',
  'createCanvas',
  'width',
  'height',
];
const P5_CONSTANTS = [
  'CENTER',
  'LEFT',
  'RIGHT',
  'TOP',
  'BOTTOM',
  'CLOSE',
  'BOLD',
  'NORMAL',
];
// Web APIs not in jsdom/Node's global by default but real in browsers,
// referenced bare by csv_parser.js/live_csv.js/ndvi_sampler.js.
const EXTRA_WEB_GLOBALS = ['TextEncoder', 'TextDecoder', 'DecompressionStream'];

// Browser/DOM/JS-builtin/vendor globals + dual-mode-tail artifacts that are
// NOT cross-file dependencies and should never appear as "needs import".
const KNOWN_GLOBALS = new Set([
  // dual-mode tail / CommonJS artifacts (irrelevant post-migration)
  'module',
  'exports',
  'require',
  'global',
  '__methods',
  '__dirname',
  '__filename',
  // JS builtins
  'Object',
  'Array',
  'String',
  'Number',
  'Boolean',
  'Date',
  'RegExp',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'Promise',
  'Symbol',
  'Proxy',
  'Reflect',
  'JSON',
  'Math',
  'Error',
  'TypeError',
  'RangeError',
  'SyntaxError',
  'ReferenceError',
  'EvalError',
  'URIError',
  'AggregateError',
  'Infinity',
  'NaN',
  'undefined',
  'isNaN',
  'isFinite',
  'parseInt',
  'parseFloat',
  'encodeURIComponent',
  'decodeURIComponent',
  'encodeURI',
  'decodeURI',
  'structuredClone',
  'globalThis',
  'BigInt',
  'ArrayBuffer',
  'Uint8Array',
  'Int8Array',
  'Uint16Array',
  'Int16Array',
  'Uint32Array',
  'Int32Array',
  'Float32Array',
  'Float64Array',
  'DataView',
  // browser/DOM
  'window',
  'document',
  'console',
  'navigator',
  'location',
  'history',
  'screen',
  'fetch',
  'XMLHttpRequest',
  'Headers',
  'Request',
  'Response',
  'AbortController',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'CacheStorage',
  'caches',
  'setTimeout',
  'clearTimeout',
  'setInterval',
  'clearInterval',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'requestIdleCallback',
  'alert',
  'confirm',
  'prompt',
  'Blob',
  'File',
  'FileReader',
  'URL',
  'URLSearchParams',
  'CustomEvent',
  'Event',
  'EventTarget',
  'MouseEvent',
  'KeyboardEvent',
  'TouchEvent',
  'HTMLElement',
  'HTMLCanvasElement',
  'Image',
  'Path2D',
  'ImageData',
  'OffscreenCanvas',
  'ResizeObserver',
  'IntersectionObserver',
  'MutationObserver',
  'matchMedia',
  'performance',
  'crypto',
  'Worker',
  'WebSocket',
  'Notification',
  'getComputedStyle',
  'DOMParser',
  'XMLSerializer',
  'atob',
  'btoa',
  // vendored non-modular libs (stay classic <script> globals post-migration)
  'L',
  'p5',
  'JSZip',
  'Cesium',
  ...P5_GLOBAL_NAMES,
  ...P5_CONSTANTS,
  ...EXTRA_WEB_GLOBALS,
]);

function readSrc(file) {
  return fs.readFileSync(path.join(APP_DIR, file), 'utf8');
}

/**
 * Returns the AST node array to treat as "top level" for this file: the
 * Program body directly, or — for the augment-file convention
 * `(function () { ...; if (typeof module...) {...} })();` — the body of
 * that single wrapping IIFE, so its internal declarations count as the
 * file's real top level rather than being invisible inside one big
 * ExpressionStatement.
 */
function effectiveTopLevel(ast) {
  if (ast.body.length === 1 && ast.body[0].type === 'ExpressionStatement') {
    const expr = ast.body[0].expression;
    const callee = expr.type === 'CallExpression' ? expr.callee : null;
    const fn =
      callee && callee.type === 'FunctionExpression'
        ? callee
        : callee && callee.type === 'ArrowFunctionExpression'
          ? callee
          : null;
    if (
      expr.type === 'CallExpression' &&
      fn &&
      fn.body.type === 'BlockStatement'
    ) {
      return fn.body.body;
    }
  }
  return ast.body;
}

function unresolvedFreeIdentifiers(ast) {
  const scopeManager = eslintScope.analyze(ast, {
    ecmaVersion: 2022,
    sourceType: 'script',
    optimistic: false,
    ignoreEval: true,
  });
  const globalScope = scopeManager.globalScope;
  const names = new Set();
  for (const ref of globalScope.through) {
    names.add(ref.identifier.name);
  }
  return names;
}

function main() {
  const perFileDeclared = {}; // file -> Set(names)
  const perFileFree = {}; // file -> Set(names)
  const parseErrors = [];

  for (const file of SCRIPT_ORDER) {
    let ast;
    try {
      ast = espree.parse(readSrc(file), PARSE_OPTIONS);
    } catch (err) {
      parseErrors.push({ file, error: err.message });
      continue;
    }
    perFileDeclared[file] = topLevelDeclaredNames(effectiveTopLevel(ast));
    perFileFree[file] = unresolvedFreeIdentifiers(ast);
  }

  // Build name -> [files that declare it] index.
  const declaredBy = new Map();
  for (const [file, names] of Object.entries(perFileDeclared)) {
    for (const name of names) {
      if (!declaredBy.has(name)) declaredBy.set(name, []);
      declaredBy.get(name).push(file);
    }
  }

  const manifest = {};
  const ambiguous = new Map(); // name -> definer files
  const unmatched = new Map(); // name -> [files that reference it]

  for (const file of SCRIPT_ORDER) {
    if (!perFileFree[file]) continue;
    const needsImport = [];
    for (const name of perFileFree[file]) {
      if (KNOWN_GLOBALS.has(name)) continue;
      const definers = (declaredBy.get(name) || []).filter((f) => f !== file);
      if (definers.length === 0) {
        if (!unmatched.has(name)) unmatched.set(name, []);
        unmatched.get(name).push(file);
      } else if (definers.length === 1) {
        needsImport.push({ name, from: definers[0] });
      } else {
        ambiguous.set(name, definers);
        needsImport.push({ name, from: definers, ambiguous: true });
      }
    }
    if (needsImport.length) manifest[file] = needsImport;
  }

  const outDir = __dirname;
  fs.writeFileSync(
    path.join(outDir, 'import_manifest.json'),
    JSON.stringify(
      {
        manifest,
        ambiguous: Object.fromEntries(ambiguous),
        unmatched: Object.fromEntries(unmatched),
        parseErrors,
      },
      null,
      2,
    ),
  );

  console.log(
    `Parsed ${SCRIPT_ORDER.length} files (${parseErrors.length} parse errors).`,
  );
  console.log(
    `${Object.keys(manifest).length} files have at least one cross-file reference to resolve.`,
  );
  console.log(
    `${ambiguous.size} names are declared in more than one file (needs manual disambiguation):`,
  );
  for (const [name, files] of ambiguous)
    console.log(`  ${name}  ->  ${files.join(', ')}`);
  console.log(
    `${unmatched.size} referenced names match no declaration anywhere (likely a missing KNOWN_GLOBALS entry, or a real bug):`,
  );
  for (const [name, files] of unmatched)
    console.log(`  ${name}  <-  ${files.join(', ')}`);
  if (parseErrors.length) {
    console.log('Parse errors:');
    for (const { file, error } of parseErrors)
      console.log(`  ${file}: ${error}`);
  }
  console.log(
    `\nFull manifest written to ${path.relative(APP_DIR, path.join(outDir, 'import_manifest.json'))}`,
  );
}

main();
