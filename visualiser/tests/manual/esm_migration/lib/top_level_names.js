/**
 * Shared by build_import_manifest.js (step 1) and tests/support/boot_app.js
 * (the realm-model test harness): finds every name a script declares at its
 * top level (FunctionDeclaration/ClassDeclaration/VariableDeclaration,
 * including the `if (typeof X === 'undefined') { class X {...} }`
 * optional-dependency guard a few files use). Pass a Program's `body` array
 * directly for a plain file's real top level, or the effective top level
 * you've already unwrapped (e.g. build_import_manifest.js's IIFE-diving for
 * the augment-file convention).
 */

function topLevelDeclaredNames(bodyStatements) {
  const names = new Set();
  for (const stmt of bodyStatements) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) names.add(stmt.id.name);
    else if (stmt.type === 'ClassDeclaration' && stmt.id)
      names.add(stmt.id.name);
    else if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) collectPatternNames(decl.id, names);
    }
    // `if (typeof X === 'undefined') { class X {...} }` guard pattern used
    // by a few files for optional-dependency classes — look one level in.
    else if (
      stmt.type === 'IfStatement' &&
      stmt.consequent.type === 'BlockStatement'
    ) {
      for (const inner of stmt.consequent.body) {
        if (inner.type === 'ClassDeclaration' && inner.id)
          names.add(inner.id.name);
        if (inner.type === 'FunctionDeclaration' && inner.id)
          names.add(inner.id.name);
      }
    }
  }
  return names;
}

/**
 * Subset of topLevelDeclaredNames() that a top-level reassignment (from a
 * LATER, separately-run vm.runInThisContext script — the same shared-realm
 * situation every boot after the first is in) does NOT throw for. Verified
 * empirically, and surprising: a `class`/`function` binding IS silently
 * reassignable from a separate script (`vm.runInThisContext('class Foo{}');
 * vm.runInThisContext('Foo = undefined;')` succeeds), exactly like `let`/
 * `var` — only `const` truly throws ("Assignment to constant variable").
 * tests/support/realm_bridge.js uses this to decide which reflected names
 * get a *setter*: a name here needs one both for legitimate internal
 * reassignment (live_view.js's `let bleManager = null;`, later reassigned
 * inside mount()) AND because several tests deliberately null out a
 * not-yet-converted file's top-level class via
 * `vm.runInThisContext('RFFluidRenderer = undefined;')` to opt out of a
 * feature — a get-only accessor would silently swallow that (sloppy-mode
 * assignment to an accessor with no setter is a no-op, not a throw) and
 * leave the real class in place. `const` alone is excluded: generating a
 * setter for one throws the moment anything writes to the reflected global
 * on a later boot — including the declaring file's own dual-mode tail
 * (e.g. ndvi_sampler.js's `global.NDVISampler = NDVISampler;`).
 */
function topLevelMutableNames(bodyStatements) {
  const names = new Set();
  for (const stmt of bodyStatements) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) names.add(stmt.id.name);
    else if (stmt.type === 'ClassDeclaration' && stmt.id)
      names.add(stmt.id.name);
    else if (
      stmt.type === 'VariableDeclaration' &&
      (stmt.kind === 'let' || stmt.kind === 'var')
    ) {
      for (const decl of stmt.declarations) collectPatternNames(decl.id, names);
    }
  }
  return names;
}

function collectPatternNames(pattern, out) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') out.add(pattern.name);
  else if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties) {
      collectPatternNames(
        prop.type === 'RestElement' ? prop.argument : prop.value,
        out,
      );
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const el of pattern.elements) collectPatternNames(el, out);
  } else if (pattern.type === 'AssignmentPattern') {
    collectPatternNames(pattern.left, out);
  } else if (pattern.type === 'RestElement') {
    collectPatternNames(pattern.argument, out);
  }
}

module.exports = {
  topLevelDeclaredNames,
  topLevelMutableNames,
  collectPatternNames,
};
