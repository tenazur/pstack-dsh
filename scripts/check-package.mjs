#!/usr/bin/env node
/**
 * check-package.mjs — what would `npm publish` actually ship, and would it run?
 *
 * `npm pack` cannot run on this machine (the npm cache is read-only: `EROFS`), so this
 * script reimplements the part of packing that matters for a plugin: resolve every
 * `files` entry and every `exports` target against the real tree, then walk the runtime
 * import graph and refuse any edge that leaves the shipped set.
 *
 * That last check is the whole point. A package can pass every test on the author's
 * machine, where `src/` and the whole repo sit next to `lib/`, and still be dead on
 * install because `lib/` imported something `files` did not ship. Tests cannot see it;
 * only a diff of "what the code reaches" against "what the tarball carries" can.
 *
 * Usage: node scripts/check-package.mjs [--package <dir>] [--json]
 * Exit:  0 clean · 1 findings · 2 could not run (a bug in this script or its inputs)
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Entries whose reachability we follow into the package. */
const RUNTIME_ENTRIES = ['lib/index.js', 'lib/client.js']

/**
 * Real Node resolvers for the two specifier kinds a bundler-free package emits.
 * We use `import.meta.resolve` rather than a hand-rolled extension list so that the
 * answer is Node's answer, not ours.
 */
const RESOLVERS = [
  // Bare specifiers (`react`, `@deepseek-ai/...`) are peer/host deps: the Host provides
  // them, so they are reported but never count as an install-time break.
  'bare',
  // Relative and file: specifiers are the package's own files and must ship.
  'relative',
]

/** ------------------------------------------------------------------ args */

function parseArgs(argv) {
  let packageDir = join(REPO_ROOT, 'plugin')
  let json = false
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--json') json = true
    else if (arg === '--package') {
      const next = argv[index + 1]
      if (next === undefined) throw new Error('--package needs a directory')
      packageDir = resolve(next)
      index += 1
    } else if (arg === '--help' || arg === '-h') {
      process.stdout.write('usage: node scripts/check-package.mjs [--package <dir>] [--json]\n')
      process.exit(0)
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return { packageDir, json }
}

/** ---------------------------------------------------------- files resolution */

/**
 * Paths npm always packs regardless of `files`: the manifest itself, plus the files npm
 * generates at pack time. An `exports` target pointing at one of these is legitimate and
 * must not be reported as unshipped.
 */
const ALWAYS_PACKED = new Set(['package.json', 'README.md', 'LICENSE', 'LICENCE', 'CHANGELOG.md', 'npm-shrinkwrap.json'])

/**
 * Resolve one `files` entry to the concrete paths it ships.
 *
 * npm ships a directory entry by walking it (minus the always-ignored names), and a file
 * entry verbatim. A missing entry is a finding, not a crash: `files` naming a path that
 * does not exist means the author believes they ship something they do not.
 */
async function resolveFilesEntry(packageDir, entry) {
  const absolute = join(packageDir, entry)
  if (!existsSync(absolute)) return { entry, kind: 'missing', paths: [] }
  const stats = await stat(absolute)
  if (stats.isFile()) return { entry, kind: 'file', paths: [absolute] }
  if (!stats.isDirectory()) return { entry, kind: 'missing', paths: [] }
  const paths = []
  await walk(absolute, paths)
  return { entry, kind: 'directory', paths }
}

/** Names npm never packs even inside a shipped directory. */
const ALWAYS_IGNORED = new Set(['.git', 'node_modules', '.DS_Store', 'npm-debug.log'])

async function walk(directory, out) {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    if (ALWAYS_IGNORED.has(entry.name)) continue
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await walk(path, out)
    else if (entry.isFile()) out.push(path)
  }
}

/** A path's size, or 0 when it vanished between walk and stat. */
async function sizeOf(path) {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

/** --------------------------------------------------------- imports + resolve */

/**
 * Every static `import`/`export ... from` specifier, plus every literal `require(...)`
 * and dynamic `import('...')`, in one JS file. A scanner, not a parser: the package is
 * tsc output, so its imports are one per line and its requires are literals. A specifier
 * computed at runtime cannot be followed and is reported as unresolved rather than
 * silently dropped.
 */
function scanSpecifiers(source) {
  const specifiers = new Set()
  const patterns = [
    /\bimport\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bexport\s+[^'";]*?\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ]
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specifiers.add(match[1])
  }
  // A computed require('...' + x) would hide an edge; say so instead of missing it.
  const computed = /\brequire\s*\(\s*[^'")]/.test(source)
  return { specifiers: [...specifiers], computed }
}

function classify(specifier) {
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier.startsWith('file:')) {
    return 'relative'
  }
  return 'bare'
}

/** Resolve a relative specifier the way Node would, from the importing file. */
function resolveRelative(importer, specifier) {
  const base = specifier.startsWith('file:')
    ? fileURLToPath(specifier)
    : resolve(dirname(importer), specifier)
  // Order matters: an exact file wins, then a directory's index, then extensions.
  const candidates = [base, join(base, 'index.js'), `${base}.js`, `${base}.mjs`, `${base}.cjs`, `${base}.json`, `${base}.node`]
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    if (statSync(candidate).isDirectory()) continue
    return candidate
  }
  return undefined
}

/**
 * Walk the import graph from the runtime entries.
 * @returns the visited edges, each labelled relative to the package dir.
 */
async function walkImports(packageDir, shippedSet) {
  const edges = []
  const visited = new Set()
  const queue = RUNTIME_ENTRIES.map((entry) => join(packageDir, entry))
  const missingEntries = queue.filter((entry) => !existsSync(entry))
  for (const entry of queue) visited.add(entry)

  while (queue.length > 0) {
    const importer = queue.shift()
    let source
    try {
      source = await readFile(importer, 'utf8')
    } catch (error) {
      edges.push({
        importer,
        specifier: '<unreadable>',
        kind: 'relative',
        resolved: undefined,
        note: error.code ?? String(error),
        inShippedSet: false,
      })
      continue
    }
    const { specifiers, computed } = scanSpecifiers(source)
    if (computed) {
      edges.push({
        importer,
        specifier: '<computed require>',
        kind: 'relative',
        resolved: undefined,
        note: 'a computed require cannot be traced statically',
        inShippedSet: false,
      })
    }
    for (const specifier of specifiers) {
      const kind = classify(specifier)
      if (!RESOLVERS.includes(kind)) continue
      const resolved = kind === 'relative' ? resolveRelative(importer, specifier) : undefined
      edges.push({
        importer,
        specifier,
        kind,
        resolved,
        inShippedSet: resolved === undefined ? kind === 'bare' : shippedSet.has(resolved),
      })
      if (resolved !== undefined && !visited.has(resolved)) {
        visited.add(resolved)
        queue.push(resolved)
      }
    }
  }
  return { edges, missingEntries }
}

/** ------------------------------------------------------------------- report */

function rel(from, path) {
  return relative(from, path).split(sep).join('/')
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
}

async function main() {
  const { packageDir, json } = parseArgs(process.argv.slice(2))
  const manifestPath = join(packageDir, 'package.json')
  if (!existsSync(manifestPath)) {
    process.stderr.write(`check-package: no package.json at ${manifestPath}\n`)
    process.exit(2)
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  const files = Array.isArray(manifest.files) ? manifest.files : []
  if (files.length === 0) {
    process.stderr.write(
      `check-package: ${rel(REPO_ROOT, manifestPath)} has no "files" array — npm would ship ` +
        `everything not ignored, and this script cannot describe that set\n`,
    )
    process.exit(2)
  }

  const findings = []

  // 1. Every `files` entry resolves, and the shipped set is the union of its paths.
  const entries = []
  for (const entry of files) {
    const resolved = await resolveFilesEntry(packageDir, entry)
    entries.push(resolved)
    if (resolved.kind === 'missing') {
      findings.push({
        kind: 'missing-files-entry',
        detail: `"${entry}" is listed in files but does not exist in the package`,
      })
    }
  }
  const shippedPaths = [...new Set(entries.flatMap((entry) => entry.paths))].sort()
  const shippedSet = new Set(shippedPaths)
  // 2. Every `exports` target resolves and ships. An `exports` target that is not in
  //    `files` is the sharpest version of the same bug: the manifest advertises a path
  //    the tarball does not contain.
  const exportsTargets = []
  const collectExports = (value, conditionPath) => {
    if (typeof value === 'string') {
      exportsTargets.push({ target: value, condition: conditionPath })
      return
    }
    if (value === null || typeof value !== 'object') return
    for (const [key, child] of Object.entries(value)) {
      collectExports(child, conditionPath === '' ? key : `${conditionPath}.${key}`)
    }
  }
  collectExports(manifest.exports, '')
  const mainTarget = typeof manifest.main === 'string' ? manifest.main : undefined
  const typesTarget = typeof manifest.types === 'string' ? manifest.types : undefined
  for (const target of [mainTarget, typesTarget].filter(Boolean)) {
    if (target.startsWith('./')) exportsTargets.push({ target, condition: 'main/types' })
  }

  const exportsReport = []
  for (const { target, condition } of exportsTargets) {
    if (!target.startsWith('./')) continue
    const absolute = resolve(packageDir, target)
    const relativeTarget = rel(packageDir, absolute)
    const exists = existsSync(absolute)
    // npm packs the manifest and a few generated files whatever `files` says.
    const alwaysPacked = ALWAYS_PACKED.has(relativeTarget)
    const ships = shippedSet.has(absolute) || alwaysPacked
    exportsReport.push({ target, condition, exists, ships, alwaysPacked })
    if (!exists) {
      findings.push({ kind: 'missing-exports-target', detail: `exports ${condition} -> ${target} does not exist` })
    } else if (!ships) {
      findings.push({
        kind: 'unshiped-exports-target',
        detail: `exports ${condition} -> ${target} exists but is not covered by "files"`,
      })
    }
  }

  // 3. The runtime import graph. This is the reason the script exists.
  const { edges, missingEntries } = await walkImports(packageDir, shippedSet)
  for (const entry of missingEntries) {
    findings.push({
      kind: 'missing-runtime-entry',
      detail: `runtime entry ${rel(packageDir, entry)} does not exist`,
    })
  }
  const breaks = edges.filter((edge) => edge.kind === 'relative' && !edge.inShippedSet)
  for (const edge of breaks) {
    findings.push({
      kind: 'runtime-import-not-shipped',
      detail:
        `${rel(packageDir, edge.importer)} imports ${JSON.stringify(edge.specifier)} -> ` +
        `${edge.resolved === undefined ? 'UNRESOLVED (no such file on disk)' : rel(packageDir, edge.resolved)}, ` +
        `which "files" does not ship — this package is broken on install`,
    })
  }

  // ---------------------------------------------------------------- output
  const totalBytes = (
    await Promise.all(shippedPaths.map(async (path) => sizeOf(path)))
  ).reduce((sum, size) => sum + size, 0)

  if (json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          package: manifest.name,
          version: manifest.version,
          packageDir,
          files,
          entries: entries.map((entry) => ({ entry: entry.entry, kind: entry.kind, count: entry.paths.length })),
          shipped: shippedPaths.map((path) => ({ path: rel(packageDir, path), bytes: undefined })),
          exports: exportsReport,
          edges: edges.map((edge) => ({
            importer: rel(packageDir, edge.importer),
            specifier: edge.specifier,
            kind: edge.kind,
            resolved: edge.resolved === undefined ? null : rel(packageDir, edge.resolved),
            inShippedSet: edge.inShippedSet,
          })),
          findings,
          totalBytes,
        },
        null,
        2,
      )}\n`,
    )
    process.exit(findings.length === 0 ? 0 : 1)
  }

  const out = []
  out.push(`check-package: ${manifest.name}@${manifest.version}`)
  out.push(`package dir: ${rel(REPO_ROOT, packageDir)}`)
  out.push('')
  out.push(`files entries (${files.length})`)
  for (const entry of entries) {
    const label = entry.kind === 'missing' ? 'MISSING' : entry.kind === 'directory' ? `${entry.paths.length} files` : '1 file'
    out.push(`  ${entry.kind === 'missing' ? '✗' : '·'} ${entry.entry.padEnd(18)} ${label}`)
  }

  out.push('')
  out.push(`would ship: ${shippedPaths.length} files, ${formatBytes(totalBytes)}`)
  const byEntry = new Map()
  for (const entry of entries) {
    if (entry.kind !== 'directory') continue
    let bytes = 0
    for (const path of entry.paths) bytes += await sizeOf(path)
    byEntry.set(entry.entry, { count: entry.paths.length, bytes })
  }
  for (const [entry, stats] of [...byEntry].sort((a, b) => b[1].bytes - a[1].bytes)) {
    out.push(`  ${entry.padEnd(18)} ${String(stats.count).padStart(4)} files  ${formatBytes(stats.bytes)}`)
  }

  const rootFiles = shippedPaths.filter((path) => dirname(path) === packageDir)
  if (rootFiles.length > 0) {
    out.push('')
    out.push('package-root files')
    for (const path of rootFiles) {
      out.push(`  ${rel(packageDir, path).padEnd(20)} ${formatBytes(await sizeOf(path))}`)
    }
  }

  out.push('')
  out.push(`exports targets (${exportsReport.length})`)
  for (const target of exportsReport) {
    const mark = !target.exists ? '✗ missing  ' : !target.ships ? '✗ not shipped' : '✓ shipped  '
    const note = target.alwaysPacked ? '  (always packed)' : ''
    out.push(`  ${mark} ${target.target}  (${target.condition})${note}`)
  }

  const bare = edges.filter((edge) => edge.kind === 'bare')
  const relative = edges.filter((edge) => edge.kind === 'relative')
  out.push('')
  out.push(`runtime import graph from ${RUNTIME_ENTRIES.join(' + ')}`)
  out.push(`  ${relative.length} relative edges, all shipped: ${breaks.length === 0 ? 'yes' : 'NO'}`)
  const bareNames = [...new Set(bare.map((edge) => edge.specifier))].sort()
  out.push(`  ${bareNames.length} bare specifiers (Host-provided, not packed): ${bareNames.join(', ') || 'none'}`)

  out.push('')
  if (findings.length === 0) {
    out.push(`OK — ${shippedPaths.length} files ship and nothing reachable from the runtime entries is left behind.`)
    process.stdout.write(`${out.join('\n')}\n`)
    process.exit(0)
  }
  out.push(`FAIL — ${findings.length} finding${findings.length === 1 ? '' : 's'}:`)
  for (const finding of findings) out.push(`  ✗ [${finding.kind}] ${finding.detail}`)
  process.stdout.write(`${out.join('\n')}\n`)
  process.exit(1)
}

main().catch((error) => {
  process.stderr.write(`check-package: could not run: ${error?.stack ?? error}\n`)
  process.exit(2)
})
