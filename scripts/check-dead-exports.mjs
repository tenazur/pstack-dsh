#!/usr/bin/env node
/**
 * Dead-export check: an exported symbol with no importer anywhere.
 *
 * Why this exists, and why it is not a grep: a name inside a comment, a template string or a
 * test's expected-output fixture looks exactly like a use to a text search. The Phase 4/5 units
 * measured that gap by hand — 77 exported types, 34 of them referenced only inside their own
 * file — and a grep-based rule would have reported either all 34 as used or all 77 as dead.
 * Parsing is the only honest way to tell an export from a mention.
 *
 * What it flags, precisely:
 *   1. An export that no other file imports and that its own file never references — dead.
 *   2. An export used only inside its own file — the `export` keyword is speculation. It is
 *      reported separately, because that is a smaller claim than "dead code" and the fix is to
 *      delete one word, not a declaration.
 *
 * Type-only exports are followed through both `import type { X }` and `import { type X }`.
 * Re-exports (`export { X } from './y.ts'`) count as uses of `./y.ts`'s `X`.
 *
 * Usage: node scripts/check-dead-exports.mjs [--prefix src] [--quiet]
 * Exit 0 = clean, 1 = findings, 2 = setup problem.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '..')

const args = process.argv.slice(2)
const quiet = args.includes('--quiet')
const prefixIdx = args.indexOf('--prefix')
const prefix = prefixIdx === -1 ? 'plugin/src' : args[prefixIdx + 1]

const root = resolve(repoRoot, prefix)
try {
  statSync(root)
} catch {
  console.error(`setup: no such directory ${root}`)
  process.exit(2)
}

// Resolve the TypeScript compiler from the plugin's own devDependencies rather than requiring a
// global install. Standing order 13: `omit=dev` is the default here, so it may legitimately be
// absent, and that is a setup problem rather than a clean result.
const require = createRequire(join(repoRoot, 'plugin', 'package.json'))
let ts
try {
  ts = require('typescript')
} catch {
  console.error(
    'setup: typescript is not installed. Run `npm install --include=dev` in plugin/ ' +
      '(standing order 13 — plain `npm install` installs nothing here).',
  )
  process.exit(2)
}

/** @param {string} dir @returns {string[]} */
function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) out.push(full)
  }
  return out
}

// Importers are searched across the whole package, not just the analysed prefix. A spec that
// imports `apply` is an importer: it is why the export exists, and calling it "referenced only
// inside its own file" would be wrong and would send a reader to delete a working seam.
const packageRoot = resolve(repoRoot, 'plugin')
const importerFiles = [...walk(root), ...walk(join(packageRoot, 'tests'))].sort()

const files = walk(root).sort()
if (files.length === 0) {
  console.error(`setup: no .ts files under ${root}`)
  process.exit(2)
}

/** The names a file exports, with the kind of declaration. */
function exportsOf(file) {
  const text = readFileSync(file, 'utf8')
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS)
  const names = []
  const reExported = new Set()
  for (const stmt of sf.statements) {
    const isExported = stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    // `export { a, b }` and `export { a } from './x.ts'`
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          names.push(el.name.text)
          // An `export … from` is a deliberate public-surface re-export. It is reachable in the
          // sense that matters even when nothing in this repo imports it: the entry module's API
          // is consumed by the Host and by the package's users, and neither is a file in this tree.
          // So it is reported separately rather than as dead.
          if (stmt.moduleSpecifier !== undefined) reExported.add(el.name.text)
        }
      }
      continue
    }
    if (!isExported) continue
    if (stmt.name && ts.isIdentifier(stmt.name)) names.push(stmt.name.text)
  }
  return { names, text, sf, reExported }
}

/** Every identifier referenced anywhere in a file, qualified names included. */
function referenceCounts(text, name) {
  const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g')
  return (text.match(re) ?? []).length
}

/**
 * Importers of `name` from `file`: files whose import declarations carry the name, plus consumers
 * of a re-export from it. Searched across the package (see `importerFiles`), so a spec counts.
 */
const sources = files.map((file) => ({ file, ...exportsOf(file) }))
const importersOf = importerFiles.map((file) => ({ file, ...exportsOf(file) }))
const findings = { dead: [], internalOnly: [], publicSurface: [] }

for (const { file, names, text, reExported } of sources) {
  const rel = relative(repoRoot, file)
  for (const name of names) {
    let importers = 0
    for (const other of importersOf) {
      if (other.file === file) continue
      const sf = other.sf
      let hit = false
      sf.forEachChild(function visit(node) {
        if (hit) return
        if (ts.isImportDeclaration(node) && node.importClause) {
          const clause = node.importClause
          // default / namespace imports cannot be name-matched; skip them
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              if (el.name.text === name) hit = true
            }
          }
        }
        // `export { name } from './somewhere.ts'` is a use of the origin's binding
        if (
          ts.isExportDeclaration(node) &&
          node.exportClause &&
          ts.isNamedExports(node.exportClause)
        ) {
          for (const el of node.exportClause.elements) {
            if ((el.propertyName ?? el.name).text === name) hit = true
          }
        }
        ts.forEachChild(node, visit)
      })
      if (hit) importers += 1
    }

    if (importers > 0) continue
    const local = referenceCounts(text, name)
    // A re-export is the public surface, not a finding to fix: `index.ts` is what the Host and a
    // package consumer import from, and neither is a file in this tree. Reported, never failed.
    if (reExported.has(name)) {
      findings.publicSurface.push({ rel, name })
      continue
    }
    // one reference is the declaration itself
    if (local <= 1) findings.dead.push({ rel, name })
    else findings.internalOnly.push({ rel, name, local })
  }
}

if (!quiet) {
  const show = (label, rows, note) => {
    if (rows.length === 0) {
      console.log(`  ok    ${label}`)
      return
    }
    console.log(`  ${rows.length}  ${label} — ${note}`)
    for (const r of rows) console.log(`          ${r.rel}: ${r.name}`)
  }
  console.log(`=== dead exports (${prefix}) ===`)
  show('exported and never referenced anywhere', findings.dead, 'delete the declaration')
  show(
    'exported but referenced only inside its own file',
    findings.internalOnly,
    'delete the `export` keyword — the declaration is live',
  )
  if (findings.publicSurface.length > 0) {
    console.log(
      `  note  ${findings.publicSurface.length} re-export(s) for the package surface — not findings`,
    )
  }
}

const total = findings.dead.length + findings.internalOnly.length
if (total === 0) {
  if (!quiet) console.log('DEAD EXPORTS: none')
  process.exit(0)
}
if (!quiet) {
  console.log(
    `DEAD EXPORTS: ${findings.dead.length} dead, ${findings.internalOnly.length} internal-only`,
  )
}
process.exit(1)
