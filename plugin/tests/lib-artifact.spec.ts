/**
 * lib-artifact — the file that actually ships must load and wire, not just the sources.
 *
 * WHY THIS SPEC EXISTS
 *
 * `plugin/package.json` publishes `lib/` (`files`) with `"main": "lib/index.js"`, and the human's
 * live Host loads that built file. Every other spec in this directory imports `../src/**.ts` and
 * runs it under `node --experimental-strip-types`, so **nothing executed the artifact**. Measured
 * on this tree: `grep -rn "from '../lib" plugin/tests/*.ts` returns nothing, and the `lib/index.js`
 * strings that do appear are DSH's own package paths used as `file:line` citations, plus
 * `lib/client.js` read as **bytes** by `card.spec.ts` and `client-served.spec.ts`.
 *
 * The gap that leaves open is concrete, not theoretical: `tsconfig.json` sets
 * `rewriteRelativeImportExtensions` and emits `./x.ts` as `./x.js`. Nothing checked that the
 * emitted graph resolves, that `apply` still exists in the emitted module, or that `lib/` is not
 * simply stale relative to `src/`. A `tsc` setting that emits a broken import path, or a stale
 * `lib/`, passed the whole suite. The coordinator's hand probe —
 * `node -e "import('./lib/index.js')"` from `plugin/` → `OK exports: 76` — is the property this
 * file makes permanent.
 *
 * WHAT THIS PROVES AND WHAT IT DOES NOT
 *
 * Proves: the built entry loads under **plain Node** (no strip-types, no `src/`); it exports a
 * callable `apply`; its transitive relative import edges all exist on disk; `apply` runs against a
 * minimal fake context and registers the three tools by name plus the skill provider; and `lib/`
 * is newer than the newest `src/**.ts`. It does not prove Cordis calls `apply` at all — that is a
 * booted Host, which is ACCEPTANCE 4 and not this unit's scope.
 *
 * WHAT IT DELIBERATELY DOES NOT ASSERT
 *
 * `apply.spec.ts` already owns the `src/` behaviour — the marker line's fields, `inject`'s exact
 * list, `registerSkills: false`, the effort listener, the end-to-end spawn wiring — and this file
 * runs **after the build** (`npm run verify` = `npm run build && npm run check`), so re-deriving
 * those from `lib/` would buy nothing and cost a spec that passes when `apply` returns undefined.
 * The two files that stay green when `lib/` is deleted are named in the report; this one makes that
 * set one smaller.
 *
 * The `apply` fake below is deliberately the same shape as `apply.spec.ts`'s `recorder()`, minus
 * the `webServer` half: `apply()` registers its HTTP routes through `ctx.inject(['webServer'], …)`,
 * so omitting `ctx.inject` keeps the run to the registrations this file asserts and out of a route
 * surface the sibling spec covers.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/** `plugin/`, derived from this spec's own URL — never `process.cwd()`, which `npm test` owns. */
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const LIB_ENTRY = join(PLUGIN_ROOT, 'lib', 'index.js')
const SRC_DIR = join(PLUGIN_ROOT, 'src')

/**
 * The three tools a Host must find after this plugin applies, and the provider name.
 *
 * Literal on purpose, and named here rather than imported from `src/`: a spec that reads the same
 * constant the code does cannot notice the constant changing. The seeded-defect probe for this
 * file renames a tool in `src/`, rebuilds, and this assertion is what fails.
 */
const REGISTERED_TOOL_NAMES = ['pstack_status', 'pstack_spawn', 'pstack_spawn_panel']
const SKILL_PROVIDER_NAME = 'pstack'

/**
 * Static `import … from '…'` / `export … from '…'` specifiers, in source order.
 *
 * One regex over the emitted text, not a parser: this file is a build-artifact check and its job is
 * to catch `tsc` emitting a path that is not there, not to be a JavaScript parser. The cost of the
 * shortcut is that a template literal containing prose can look like an import — measured on this
 * tree, `lib/roles/fleet-groups.js:808` holds
 * `` repairs.push(`unassigned "${task}" from "${violin.id}" because …`) ``, so `" from "` inside a
 * message read as an edge named `${violin.id}` when the first version of this spec ran. The fix is
 * the `[ \t]` around `from`: a real `from` clause is whitespace-separated on one line, a sentence
 * is not. Backtick specifiers are refused for the same reason — a specifier never interpolates.
 */
function importSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:^|[^.\w$])from[ \t]+['"]([^'"\n]+)['"]/g)].map((match) => match[1] ?? '')
}

/**
 * Dynamic `import('…')` specifiers, which are edges too.
 *
 * Single-quoted or double-quoted only: a template literal is never a specifier in this build, and
 * the client bundle is full of `` `summary-${violin.id}` ``.
 */
function dynamicSpecifiers(source: string): string[] {
  return [...source.matchAll(/(?:^|[^.\w$])import[ \t]*\([ \t]*['"]([^'"\n]+)['"][ \t]*\)/g)].map((match) => match[1] ?? '')
}

interface Edge {
  readonly from: string
  readonly specifier: string
  readonly target: string
}

interface Graph {
  /** Absolute paths of the files the walk visited, each once. */
  readonly visited: string[]
  readonly relativeEdges: Edge[]
  /** Bare specifiers (`node:fs`, `@deepseek-ai/…`) — Host-provided, never packed. */
  readonly bareSpecifiers: Set<string>
}

/**
 * Walk the emitted graph from `entry`, following **relative** edges only.
 *
 * Bare specifiers are collected and not followed: they are the Host's (`node:*`,
 * `@deepseek-ai/*`), which `scripts/check-package.mjs` independently checks against `files`. The
 * relative edges are the ones `tsc` invents, so they are the ones that can point at nothing.
 */
async function walkEdges(entry: string): Promise<Graph> {
  const visited: string[] = []
  const relativeEdges: Edge[] = []
  const bareSpecifiers = new Set<string>()
  const queue = [entry]

  while (queue.length > 0) {
    const file = queue.shift()
    if (file === undefined || visited.includes(file)) continue
    visited.push(file)

    const source = await readFile(file, 'utf8')
    for (const specifier of [...importSpecifiers(source), ...dynamicSpecifiers(source)]) {
      if (!specifier.startsWith('.')) {
        bareSpecifiers.add(specifier)
        continue
      }
      const target = resolve(dirname(file), specifier)
      relativeEdges.push({ from: file, specifier, target })
      queue.push(target)
    }
  }
  return { visited, relativeEdges, bareSpecifiers }
}

/** Every regular file under `dir`, recursively. */
async function walkFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name)
      return entry.isDirectory() ? walkFiles(path) : [path]
    }),
  )
  return files.flat()
}

const missing = (path: string): string => relative(PLUGIN_ROOT, path)

test('the published entry is where package.json says it is', async () => {
  const manifest = JSON.parse(await readFile(join(PLUGIN_ROOT, 'package.json'), 'utf8')) as {
    main?: string
    files?: string[]
  }
  assert.equal(manifest.main, 'lib/index.js', 'package.json main moved; this spec walks the wrong file')
  assert.ok(manifest.files?.includes('lib'), 'lib/ is no longer published, so nothing ships the entry')
  assert.ok(existsSync(LIB_ENTRY), `${missing(LIB_ENTRY)} does not exist — run: npm run build`)
})

test('plain Node loads lib/index.js and it exports a callable apply', async () => {
  // `import()` of the real path, under plain Node: no strip-types, no `src/`, nothing but the
  // artifact and its emitted graph. This is the Host's load, minus the Host.
  const module = (await import(pathToFileURL(LIB_ENTRY).href)) as Record<string, unknown>

  // Containment, not equality: the entry re-exports the whole role/settings surface and grows.
  assert.ok(
    typeof module['apply'] === 'function',
    `lib/index.js exported no callable apply; exports were: ${Object.keys(module).sort().join(', ')}`,
  )
  assert.equal(module['name'], 'pstack', 'the entry lost the plugin name Cordis reads')
  // The generated client bundle must never be in the entry graph: it dereferences `window` and
  // would throw the moment a Host imported it (`node -e "import('./lib/client.js')"` →
  // "window is not defined", measured).
  assert.deepEqual(await walkEdges(LIB_ENTRY).then((graph) => graph.visited.filter((f) => f.endsWith('client.js'))), [])
})

test('every relative import edge in the emitted graph resolves to a file on disk', async () => {
  const graph = await walkEdges(LIB_ENTRY)
  assert.ok(graph.relativeEdges.length >= 10, `expected the entry to have a real graph, saw ${graph.relativeEdges.length} edges`)

  const broken = graph.relativeEdges.filter((edge) => !existsSync(edge.target)).map((edge) => `${missing(edge.from)} → ${edge.specifier}`)
  assert.deepEqual(
    broken,
    [],
    `the emitted graph points at files that do not exist:\n  ${broken.join('\n  ')}\nRun: npm run build`,
  )

  // The walk is graph-wide, not entry-only: if it stopped at the entry this test would pass on a
  // broken `roles/catalog.js`. `catalog.js` is reachable only through `roles/resolver.js` and
  // `settings/http.js`, so finding it proves the transitive hop happened.
  const visitedNames = graph.visited.map((file) => relative(PLUGIN_ROOT, file))
  for (const expected of ['lib/index.js', 'lib/roles/resolver.js', 'lib/roles/catalog.js', 'lib/settings/http.js', 'lib/tools/spawn.js']) {
    assert.ok(visitedNames.includes(expected), `${expected} was not reached by the walk: ${visitedNames.join(', ')}`)
  }

  // Bare specifiers are the Host's and are read only to keep the scan honest about what it saw.
  // Deliberately *not* asserted: `scripts/check-package.mjs` owns the "every runtime import is
  // shipped or Host-provided" property over both entries, and a text scan here cannot decide it —
  // prose in a template literal reads as a specifier (measured: this line's `"…" from "${violin.id}"`
  // message), so an assertion on this set is an assertion about English, not about the artifact.
  assert.ok(graph.bareSpecifiers.has('node:fs/promises'), `the walk lost the entry's real bare imports: ${[...graph.bareSpecifiers].join(', ')}`)
})

test('apply() from lib/ registers the three tools by name and the skill provider', async () => {
  const module = (await import(pathToFileURL(LIB_ENTRY).href)) as { apply: (ctx: unknown, config?: unknown) => void }

  const providers: { name?: string }[] = []
  const tools: { name?: string }[] = []
  const lines: string[] = []
  // Same shape as `apply.spec.ts`'s recorder, minus `inject`/`effect` (see this file's header): the
  // fake is the honest stand-in for a Host's registries and nothing more.
  const ctx = {
    logger: { info: (message: string) => lines.push(message), warn: () => {} },
    skills: {
      registerProvider: (create: (control: unknown) => { name?: string }) => {
        providers.push(create({ signal: new AbortController().signal, invalidate: () => {} }))
        return () => {}
      },
    },
    tools: { register: (definition: { name?: string }) => void tools.push(definition) },
    subagents: { start: async () => ({}) },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => ({ reasoning: { efforts: [] } }),
    },
    credentials: { describe: async () => ({ configured: false }) },
    settings: { get: () => undefined },
    on: () => () => {},
  }

  module.apply(ctx, { overlayPath: '/nonexistent/pstack.json' })

  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [...REGISTERED_TOOL_NAMES].sort(),
    'the built entry registered different tools than the Host expects',
  )
  assert.equal(providers.length, 1, 'the built entry registered no skill provider')
  assert.equal(providers[0]?.name, SKILL_PROVIDER_NAME)
  // The marker line is the only boot evidence a Host log carries. Asserted as a prefix rather than
  // whole-line equality: `apply.spec.ts` owns the field-by-field shape.
  assert.ok(
    (lines[0] ?? '').startsWith('[dsh-pstack] loaded'),
    `the built entry logged no boot marker; lines were: ${JSON.stringify(lines)}`,
  )
})

test('lib/ is not stale: no source file is newer than the built entry', async () => {
  const built = await stat(LIB_ENTRY)
  const sources = await walkFiles(SRC_DIR)
  assert.ok(sources.length > 0, `no sources under ${missing(SRC_DIR)}; the staleness check would be vacuous`)

  const stamped = await Promise.all(sources.map(async (path) => ({ path, mtimeMs: (await stat(path)).mtimeMs })))
  const newest = stamped.reduce((a, b) => (b.mtimeMs > a.mtimeMs ? b : a))
  assert.ok(
    newest.mtimeMs <= built.mtimeMs,
    `${missing(newest.path)} is newer than ${missing(LIB_ENTRY)} — lib/ is stale. Run: npm run build\n` +
      `  source: ${new Date(newest.mtimeMs).toISOString()}\n  built:  ${new Date(built.mtimeMs).toISOString()}`,
  )
})
