/**
 * ES-module migration codemod (step 3). Mechanically converts ONE src/
 * file from the dual-mode-tail convention to real export/import, using
 * AST node ranges (not full codegen) so everything outside the tail and
 * the inserted import block is byte-identical to the original — the same
 * "verify the body didn't change" discipline the globe3d.js/renderer.js
 * splits used.
 *
 * What it does, precisely:
 *  1. Parses the file. If its entire body is one top-level IIFE (the
 *     ui_*.js/map_manager_*.js/globe3d_*.js/renderer_*.js augment-file
 *     convention), unwraps it — the IIFE's own body becomes the file's
 *     real top level (ESM already gives every file its own scope, so the
 *     manual IIFE-for-isolation is redundant).
 *  2. Deletes the dual-mode tail: the TRAILING run of top-level statements
 *     whose test contains `typeof module` or `typeof window` (three tail
 *     shapes exist — if/else combined; two separate top-level ifs, either
 *     order — handled uniformly). Only a trailing run, not any such
 *     statement anywhere: a `typeof window` check can also be genuine
 *     application logic elsewhere in the file (see notices.js), shape-
 *     identical to the tail's own guard. Within the tail, a real
 *     composition side effect (`Object.assign(GSRUI, __methods)`, the
 *     augment-file convention) survives as an unconditional statement; a
 *     plain `window.X = X` exposure (now redundant — `X` is `export`ed)
 *     is dropped like the rest of the tail.
 *  3. Prepends one `import { A, B } from '...'` line per source file in
 *     the manifest entry for this file (relative path, `.js` extension,
 *     computed from the two files' real directories).
 *  4. Adds `export ` in front of every remaining top-level
 *     const/let/var/function/class declaration (this is deliberately
 *     broader than "only what the manifest says other files need" — it
 *     preserves the file's full former window/module.exports surface, so
 *     a name only a not-yet-converted test needs isn't silently dropped).
 *
 * Does NOT touch anything else in the file — no reformatting, no renames.
 *
 * Usage: node convert_file.js <relative/path/to/src/file.js> [--write]
 * Without --write, prints the converted source to stdout for review.
 */
const fs = require('fs');
const path = require('path');
const espree = require('espree');

const APP_DIR = path.join(__dirname, '..', '..', '..');
const PARSE_OPTIONS = { ecmaVersion: 2022, sourceType: 'script', loc: true, range: true };

function isTypeofGuard(stmt) {
  if (stmt.type !== 'IfStatement') return false;
  const src = JSON.stringify(stmt.test); // cheap: just need to know if it MENTIONS typeof module/window anywhere in the test
  return /"operator":"typeof"/.test(src) && (mentionsName(stmt.test, 'module') || mentionsName(stmt.test, 'window'));
}

// A guard's CommonJS branch (module.exports=..., Object.assign(global, require(...))
// bridging) is always dropped outright — none of it has any meaning once
// the file has a real export. Its browser branch is NOT always droppable
// wholesale: augment files (ui_*.js/map_manager_*.js/globe3d_*.js/
// renderer_*.js) put their real composition side effect there
// (`Object.assign(GSRUI, __methods)` etc) — that call must survive,
// hoisted to an unconditional top-level statement; a plain
// `window.X = X` / `global.X = X` exposure statement is genuinely
// redundant once `X` is `export`ed and is dropped like the CommonJS branch.
function isDroppableExposure(s) {
  if (s.type !== 'ExpressionStatement' || s.expression.type !== 'AssignmentExpression') return false;
  const left = s.expression.left;
  if (left.type !== 'MemberExpression' || left.object.type !== 'Identifier') return false;
  return left.object.name === 'window' || left.object.name === 'global' || left.object.name === 'module';
}
function isKeepableComposition(s) {
  if (s.type !== 'ExpressionStatement' || s.expression.type !== 'CallExpression') return false;
  const callee = s.expression.callee;
  return callee.type === 'MemberExpression' && callee.object.type === 'Identifier' && callee.object.name === 'Object'
    && callee.property.type === 'Identifier' && callee.property.name === 'assign';
}

/** Branches of a typeof-module/window guard: `module`'s own branch is always CommonJS-only; `window`'s (or the `else` of a combined if/else) may hold browser-path code. */
function guardBranches(ifStmt) {
  const branches = [];
  if (!mentionsName(ifStmt.test, 'module')) branches.push(ifStmt.consequent);
  if (ifStmt.alternate) branches.push(ifStmt.alternate);
  return branches;
}

/**
 * True only if EVERY statement in the guard's browser-path branch(es) is
 * one of the two shapes the dual-mode tail actually uses (a composition
 * `Object.assign(...)` call, or a now-redundant `window.X = X` exposure).
 * `notices.js` has a `typeof window !== 'undefined'` block at the very end
 * of the file — same position and outer shape as a real tail guard — but
 * it wraps genuine application logic (real `window.addEventListener(...)`
 * registration), not dual-mode plumbing. Content-checking, not just
 * checking the `if`'s test, is what tells the two apart.
 */
function isFullyClassifiableGuard(stmt) {
  if (!isTypeofGuard(stmt)) return false;
  for (const branch of guardBranches(stmt)) {
    const stmts = branch.type === 'BlockStatement' ? branch.body : [branch];
    if (!stmts.every((s) => isKeepableComposition(s) || isDroppableExposure(s))) return false;
  }
  return true;
}

/**
 * Only a *trailing run* of fully-classifiable guards is the real dual-mode
 * tail. Scanning from the end and stopping at the first statement that
 * isn't one keeps any non-tail guard (`notices.js`'s window.onerror setup,
 * or a genuine `typeof window` check elsewhere in a file) completely
 * untouched, verbatim, as ordinary code.
 */
function trailingGuardStart(topBody) {
  let i = topBody.length;
  while (i > 0 && isFullyClassifiableGuard(topBody[i - 1])) i--;
  return i;
}

/** For a confirmed tail guard, returns the AST statement nodes (0+) to keep, hoisted to unconditional top level. */
function guardKeptStatements(ifStmt) {
  const keep = [];
  for (const branch of guardBranches(ifStmt)) {
    const stmts = branch.type === 'BlockStatement' ? branch.body : [branch];
    for (const s of stmts) if (isKeepableComposition(s)) keep.push(s);
  }
  return keep;
}

function mentionsName(node, name) {
  if (!node || typeof node !== 'object') return false;
  if (node.type === 'Identifier' && node.name === name) return true;
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'range' || key === 'parent') continue;
    const val = node[key];
    if (Array.isArray(val)) { if (val.some((v) => mentionsName(v, name))) return true; }
    else if (val && typeof val === 'object') { if (mentionsName(val, name)) return true; }
  }
  return false;
}

function unwrapIIFEIfPresent(ast) {
  if (ast.body.length !== 1 || ast.body[0].type !== 'ExpressionStatement') return null;
  const expr = ast.body[0].expression;
  if (expr.type !== 'CallExpression') return null;
  const fn = expr.callee;
  if (fn.type !== 'FunctionExpression' && fn.type !== 'ArrowFunctionExpression') return null;
  if (fn.body.type !== 'BlockStatement') return null;
  return fn.body; // the BlockStatement node; .body is the statement array, .range covers `{ ... }`
}

function topLevelDeclaredNames(bodyStatements) {
  const names = [];
  for (const stmt of bodyStatements) {
    if (stmt.type === 'FunctionDeclaration' && stmt.id) names.push(stmt.id.name);
    else if (stmt.type === 'ClassDeclaration' && stmt.id) names.push(stmt.id.name);
    else if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations) {
        if (decl.id.type === 'Identifier') names.push(decl.id.name);
      }
    }
  }
  return names;
}

/**
 * `visualiser/package.json` has no `"type": "module"` yet (deferred to the
 * final browser/harness cutover), so a real `export`/`import` file can't
 * safely be named `.js` mid-migration — Node would still try to parse it
 * as CommonJS. Converted files get a `.mjs` extension for the duration of
 * the migration (a final mechanical rename pass at cutover restores
 * `.js`); every import target this codemod ever emits is guaranteed
 * already-converted (files convert strictly in dependency order), so
 * always pointing at `.mjs` here is correct, not a guess.
 */
function relativeImportPath(fromFile, toFile) {
  const fromDir = path.dirname(fromFile);
  const toMjs = toFile.replace(/\.js$/, '.mjs');
  let rel = path.relative(fromDir, toMjs).split(path.sep).join('/');
  if (!rel.startsWith('.')) rel = './' + rel;
  return rel;
}

function convert(relFile, manifestEntry) {
  const absPath = path.join(APP_DIR, relFile);
  const src = fs.readFileSync(absPath, 'utf8');
  const ast = espree.parse(src, PARSE_OPTIONS);

  const iifeBlock = unwrapIIFEIfPresent(ast);
  const topBody = iifeBlock ? iifeBlock.body : ast.body;

  // Build import block, grouped by source file.
  const bySource = new Map();
  for (const need of (manifestEntry || [])) {
    const froms = Array.isArray(need.from) ? need.from : [need.from];
    if (froms.length !== 1) throw new Error(`${relFile}: ambiguous import for ${need.name} (${froms.join(', ')}) — resolve by hand, not via codemod`);
    const from = froms[0];
    if (!bySource.has(from)) bySource.set(from, []);
    bySource.get(from).push(need.name);
  }
  const importLines = [...bySource.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([from, names]) => `import { ${names.sort().join(', ')} } from '${relativeImportPath(relFile, from)}';`);

  // Splice: keep everything textually BEFORE the real top-level body
  // (leading header comment, and for IIFE files the `(function () {` open)
  // is dropped instead — see below), then each kept statement verbatim by
  // its own source range (so internal formatting/comments are untouched),
  // separated by exactly the original inter-statement gap.
  const pieces = [];
  // Non-IIFE: start exactly at the first kept statement, so its `gap` is
  // empty (the header slice below already owns everything before it).
  // IIFE: start one char past the block's own `{`, so the first inner
  // statement's `gap` is just its normal leading whitespace/comment.
  let cursor = iifeBlock ? iifeBlock.range[0] + 1 : ast.body[0].range[0];
  const tailStart = trailingGuardStart(topBody);
  for (let idx = 0; idx < topBody.length; idx++) {
    const stmt = topBody[idx];
    if (idx >= tailStart) { // confirmed part of the real dual-mode tail
      const gap = src.slice(cursor, stmt.range[0]);
      const kept = guardKeptStatements(stmt);
      // Real composition side effects (Object.assign(GSRUI, __methods) etc)
      // survive as unconditional statements, in their original relative
      // order, joined by a single newline — everything else in the guard
      // (CommonJS branch, plain window.X=X exposure) is dropped outright.
      const keptText = kept.map((s) => src.slice(s.range[0], s.range[1])).join('\n');
      pieces.push(kept.length ? gap + keptText : '');
      cursor = stmt.range[1];
      continue;
    }
    const gap = src.slice(cursor, stmt.range[0]);
    let text = src.slice(stmt.range[0], stmt.range[1]);
    const isDeclExport = (
      (stmt.type === 'FunctionDeclaration' && stmt.id) ||
      (stmt.type === 'ClassDeclaration' && stmt.id) ||
      stmt.type === 'VariableDeclaration'
    );
    pieces.push(gap + (isDeclExport ? 'export ' : '') + text);
    cursor = stmt.range[1];
  }
  const bodyText = pieces.join('').replace(/\s+$/, '\n');

  // Leading header: whatever text precedes the first top-level statement —
  // for a plain file that's just a leading doc-comment (if any); for an
  // IIFE-wrapped augment file it's the SAME leading doc-comment (comments
  // aren't AST nodes, so they're already captured by this slice either
  // way) — the `(function () {` opener itself is dropped entirely, since
  // bodyText starts one character past its `{` (see `cursor` above) and
  // the matching trailing `})();` is never included (we stop at each kept
  // statement's own range, never reaching bodyRange[1] or beyond).
  const header = src.slice(0, ast.body[0].range[0]);

  const importBlock = importLines.length ? importLines.join('\n') + '\n\n' : '';
  return (header + importBlock + bodyText).replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '\n') + '\n';
}

module.exports = { convert, isTypeofGuard, topLevelDeclaredNames, unwrapIIFEIfPresent };

if (require.main === module) {
  const relFile = process.argv[2];
  const write = process.argv.includes('--write');
  if (!relFile) { console.error('Usage: node convert_file.js <relative/path/to/src/file.js> [--write]'); process.exit(1); }
  const { manifest } = require('./import_manifest.json');
  const out = convert(relFile, manifest[relFile]);
  if (write) {
    const mjsFile = relFile.replace(/\.js$/, '.mjs');
    fs.writeFileSync(path.join(APP_DIR, mjsFile), out);
    fs.unlinkSync(path.join(APP_DIR, relFile));
    console.log(`Wrote ${mjsFile}, removed ${relFile}`);
  } else {
    process.stdout.write(out);
  }
}
