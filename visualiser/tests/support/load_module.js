/**
 * Loads one src/ file's export as a bare `global.<varName>` binding, for the
 * ~34 lightweight (non-jsdom) unit test files that don't boot the full app
 * via boot_app.js and instead vm-load individual src/ files directly.
 *
 * Mirrors boot_app.js's own resolveFile()/realm-model rules (see that
 * file's header comment for the full rationale) so these tests keep working
 * unmodified as their src/ dependencies convert from the dual-mode tail to
 * real ES modules one file at a time:
 *   - not yet converted (.js): the original regex-rewrite technique these
 *     test files used individually before being pointed at this shared
 *     helper — turn `class X {` / `const X =` into `global.X = class X {` /
 *     `global.X =`, run via vm.runInThisContext. A plain, freely-
 *     overwritable `global.X` property (not a lexical declaration) is what
 *     makes this safe to call repeatedly across a process — see
 *     boot_app.js's wrapForRepeatedExecution comment for why a bare
 *     `class`/`const` declaration in the same realm can't be.
 *   - already converted (.mjs exists): a plain synchronous `require()` of
 *     the real module (Node natively supports require()-ing an ES module
 *     with no top-level await — verified against this project's converted
 *     files), copying every export onto `global` — same idea as
 *     boot_app.js's `Object.assign(global, mod)` bridge for a converted
 *     file, minus the `await`: these ~34 files call loadModule() at plain
 *     module top level (no test.before() hook, some aren't even node:test
 *     files at all — see e.g. test_svg_vector_surface.js's top-level
 *     asserts), so staying synchronous keeps every caller unchanged.
 */
const fs = require('fs');
const vm = require('vm');

function loadModule(filePath, varName) {
  const mjsPath = filePath.replace(/\.js$/, '.mjs');
  if (fs.existsSync(mjsPath)) {
    Object.assign(global, require(mjsPath));
    return;
  }
  const src = fs.readFileSync(filePath, 'utf8');
  const wrapped = src
    .replace(new RegExp(`class ${varName}\\s*{`), `global.${varName} = class ${varName} {`)
    .replace(new RegExp(`const ${varName}\\s*=`), `global.${varName} =`);
  vm.runInThisContext(wrapped, { filename: filePath });
}

module.exports = { loadModule };
