/**
 * Every relative path a test file uses to reach into the app source must
 * resolve to a real file. The suite loads app modules three different ways —
 * `require('../src/…')`, `path.join(__dirname, '..', 'src', …)` fed to
 * readFileSync, and custom `loadModule('../src/…')` helpers — and a directory
 * move that misses any one of them leaves a path that points nowhere. That
 * shows up as a single opaque "Cannot find module" mid-run, or (for the
 * readFileSync forms) a confusing downstream ReferenceError.
 *
 * This walks tests/ and checks every statically-resolvable relative file
 * reference that lands inside visualiser/. References that resolve outside
 * visualiser/ (repo-root tracks/ CSV fixtures, os.tmpdir() scratch files) are
 * a separate concern and skipped.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const TESTS_DIR = __dirname;
const VIS_DIR = path.join(__dirname, '..');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const QUOTED = /^(['"])(.*)\1$/;

/** ordered string-literal references a source line makes to a relative file */
function refsIn(src) {
  const refs = [];

  // combined form: '../x.js' | './support/y.js' | '../../tracks/z.csv'
  for (const m of src.matchAll(/(['"])(\.\.?\/[^'"]*?\.(?:js|json|csv|html))\1/g)) {
    refs.push(m[2]);
  }

  // split form: path.join(__dirname, '..', 'src', 'signal', 'x.js')
  for (const m of src.matchAll(/path\.join\(\s*__dirname\s*,\s*([^)]*)\)/g)) {
    const parts = m[1].split(',').map((s) => s.trim());
    if (parts.every((p) => QUOTED.test(p))) {
      refs.push(path.join(...parts.map((p) => p.match(QUOTED)[2])));
    }
  }

  // concat form: __dirname + '/../x.js'
  for (const m of src.matchAll(/__dirname\s*\+\s*(['"])([^'"]+)\1/g)) {
    refs.push(m[2]);
  }

  return refs;
}

test('every relative source path used by tests/ resolves inside visualiser/', () => {
  const broken = [];

  for (const file of walk(TESTS_DIR)) {
    if (file === __filename) continue; // this file's doc comment holds example paths
    const src = fs.readFileSync(file, 'utf8');
    for (const ref of new Set(refsIn(src))) {
      const resolved = path.resolve(path.dirname(file), ref);
      if (path.relative(VIS_DIR, resolved).startsWith('..')) continue; // outside visualiser/
      if (fs.existsSync(resolved) || fs.existsSync(resolved + '.js')) continue;
      broken.push(`${path.relative(VIS_DIR, file)} → '${ref}'`);
    }
  }

  assert.deepStrictEqual(broken, [], `unresolvable source path(s):\n  ${broken.join('\n  ')}`);
});
