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
    else if (stmt.type === 'ClassDeclaration' && stmt.id) names.add(stmt.id.name);
    else if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) collectPatternNames(decl.id, names);
    }
    // `if (typeof X === 'undefined') { class X {...} }` guard pattern used
    // by a few files for optional-dependency classes — look one level in.
    else if (stmt.type === 'IfStatement' && stmt.consequent.type === 'BlockStatement') {
      for (const inner of stmt.consequent.body) {
        if (inner.type === 'ClassDeclaration' && inner.id) names.add(inner.id.name);
        if (inner.type === 'FunctionDeclaration' && inner.id) names.add(inner.id.name);
      }
    }
  }
  return names;
}

function collectPatternNames(pattern, out) {
  if (!pattern) return;
  if (pattern.type === 'Identifier') out.add(pattern.name);
  else if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties) {
      collectPatternNames(prop.type === 'RestElement' ? prop.argument : prop.value, out);
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const el of pattern.elements) collectPatternNames(el, out);
  } else if (pattern.type === 'AssignmentPattern') {
    collectPatternNames(pattern.left, out);
  } else if (pattern.type === 'RestElement') {
    collectPatternNames(pattern.argument, out);
  }
}

module.exports = { topLevelDeclaredNames, collectPatternNames };
