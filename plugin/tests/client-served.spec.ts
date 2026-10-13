/**
 * The **host half of the serving contract**: does DSH's client-module system actually pick this
 * package up and advertise `exports["./client"]` to the browser?
 *
 * This is the seam three other checks leave open, and the one that failed silently until now:
 *
 * - `scripts/check-page-layout.mjs` renders `lib/client.js` in Chromium — it proves the **bundle**
 *   renders, having loaded it by hand;
 * - `plugin/tests/client.spec.ts` feeds the bundle a captured payload — it proves the bundle
 *   renders **that payload**, again having loaded it by hand;
 * - neither asks whether the running Host ever names this package, so a `package.json` that stopped
 *   declaring `dsh.client`, an `exports["./client"]` pointing at a file the build no longer emits,
 *   or a subscription that dropped `dsh-pstack` from the boot graph would leave every gate green
 *   and the human's settings page blank.
 *
 * Every rule asserted here is read from the machine's own copy of `@deepseek-ai/dsh-client-modules`
 * rather than restated. Two of them are worth naming before the tests:
 *
 * - the declaration is parsed by `parseDshClient` (`dsh-client-modules/lib/index.js:61-80`) and the
 *   bundle resolved by `clientExportOf` (`:171-181`); a declaration that is malformed, or that
 *   declares `dsh.client` without an `exports["./client"]`, is an **error**, not a "not a client
 *   package" verdict (`:714`). At activation those errors aggregate into one throw
 *   (`ClientPackageCompositionError`, `:144-160`; thrown at `:544`), and a bundle that is declared but
 *   absent aggregates as `MissingClientBundleError` (`:130-141`, `:809-821`).
 * - what reaches the browser is the **combo** artifact (`buildCombo`, `:278-314`) at
 *   `comboUrl` = `/plugins/??<id>/client.js&rev=<rev>` (`:207-215`), registered as a
 *   `kind: "prefix", path: "/plugins"` web route (`:541-551`), and the graph itself is injected as
 *   `window.__DSH_BOOT__` by `bootInjections` (`:453-497`).
 *
 * The four groups of assertions, and where each reads its truth from:
 *
 * 1. **the declaration** — `plugin/package.json`, parsed by the real `parseDshClient`, resolved by
 *    the real `clientExportOf`;
 * 2. **the bytes** — the resolved file must *be* `plugin/lib/client.js` (compared by inode, not by
 *    a string prefix, so a resolver that silently picked another file fails) and must carry the
 *    markers `plugin/src/client/client.ts` emits;
 * 3. **the factory contract the loader requires** — through the real `buildCombo`, so this asserts
 *    on the exact bytes the route would serve rather than on the file again;
 * 4. **the negative** — malformed declarations and vanished bundles must be **rejected**, driven
 *    through the same real parser and the same real activation path.
 *
 * What this does **not** prove, and the report says so: that a live Host names the package in its
 * own boot graph. That is the optional probe in the unit report, not this file.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'

/**
 * The machine's copy of the Harness client-module system. Addressed by absolute path because this
 * package deliberately has no dependency on the Host — it is installed *into* one — and because the
 * standing order is "Harness truth is the source on this machine", not "whatever npm would resolve".
 * Its own dependencies (`@deepseek-ai/cordis`) resolve from the Harness tree it sits in.
 */
const DSH_CLIENT_MODULES = '/usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-modules/lib/index.js'

/**
 * The Harness copy of the client-module system, loaded for real: its `ClientModuleRegistry`,
 * `bootInjections` and `orderByModuleGraph` are the machine's own code, so the structural rules
 * (the graph shape, the rejection path) are exercised rather than restated.
 */
const modules = (await import(DSH_CLIENT_MODULES)) as Record<string, any>
const REGISTRY_SOURCE = readFileSync(DSH_CLIENT_MODULES, 'utf8')

/**
 * Three helpers this spec needs are module-internal: `parseDshClient`, `clientExportOf` and
 * `buildCombo`. The Harness install is **read-only** (`EROFS` on write, and a test may not modify
 * the Host anyway), so instead of re-implementing their rules — which would let this spec agree
 * with itself while the Host moved on — each one is **lifted out of the machine's own source text**
 * and evaluated. The lift is anchored on the definition and closed by brace counting, and it
 * refuses to return anything if the anchor is gone, so an upstream rename fails this spec instead
 * of quietly testing a stale copy.
 *
 * `parseDshClient` and `clientExportOf` are pure. `buildCombo` is not: it is taken from the module
 * namespace (the real one), with only `comboSource`, `identitySectionMap` and `comboSectionMap`
 * supplied from the source text, because those three are the pure byte-level helpers it stands on.
 */
function lift(name: string): any {
  const start = REGISTRY_SOURCE.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${DSH_CLIENT_MODULES} no longer defines ${name}; this spec's lift anchor is stale`)
  let depth = 0
  for (let pos = REGISTRY_SOURCE.indexOf('{', start); pos < REGISTRY_SOURCE.length; pos += 1) {
    if (REGISTRY_SOURCE[pos] === '{') depth += 1
    else if (REGISTRY_SOURCE[pos] === '}') {
      depth -= 1
      if (depth === 0) {
        const text = REGISTRY_SOURCE.slice(start, pos + 1)
        return new Function(`${text}; return ${name}`)()
      }
    }
  }
  throw new Error(`${DSH_CLIENT_MODULES}: ${name} never closes`)
}

/**
 * The real `buildCombo`, wired to the real pure helpers it calls.
 *
 * ## Why this adapter is version-sensitive, and how it fails
 *
 * `buildCombo` is not exported, so its body is lifted from the machine's source text and applied
 * to helpers that are lifted the same way. The helper *set* is therefore part of the contract: in
 * Harness 0.2.0-rc.2 the old single-resource `comboSource(resource)` and `sourceMapSnapshot` were
 * replaced by `prepareSource(resource)` plus the two assembly functions below, and `comboUrl`
 * gained a `comboSearch` dependency and a module-level `PLUGIN_ROUTE`.
 *
 * A stale set must fail loudly rather than half-work, so every lift asserts its anchor exists. When
 * the harness moves again, the failure names the missing function — that is the signal to re-derive
 * this list, not a reason to make the lift tolerant.
 */
const buildCombo = ((): any => {
  const start = REGISTRY_SOURCE.indexOf('function buildCombo(')
  assert.ok(start >= 0, `${DSH_CLIENT_MODULES} no longer defines buildCombo`)
  let depth = 0
  for (let pos = REGISTRY_SOURCE.indexOf('{', start); pos < REGISTRY_SOURCE.length; pos += 1) {
    if (REGISTRY_SOURCE[pos] === '{') depth += 1
    else if (REGISTRY_SOURCE[pos] === '}') {
      depth -= 1
      if (depth === 0) {
        const text = REGISTRY_SOURCE.slice(start, pos + 1)
        // The two module-level literals the lifted helpers close over. Read out of the source text
        // rather than restated: a restated PLUGIN_ROUTE would let this spec agree with itself while
        // the Host served a different prefix.
        const PLUGIN_ROUTE = REGISTRY_SOURCE.match(/const PLUGIN_ROUTE = "([^"]+)"/)?.[1]
        assert.ok(typeof PLUGIN_ROUTE === 'string', 'PLUGIN_ROUTE is no longer a string literal in the Harness source')
        const HASH_REVISION_LENGTH = Number(REGISTRY_SOURCE.match(/const HASH_REVISION_LENGTH = (\d+)/)?.[1])
        assert.ok(Number.isSafeInteger(HASH_REVISION_LENGTH), 'HASH_REVISION_LENGTH is no longer a literal in the Harness source')
        const SOURCE_MAP_TRAILER = /(?:\r?\n)?\/\/# sourceMappingURL=[^\r\n]*(?:\r?\n)?$/
        const SOURCE_URL_TRAILER = /(?:\r?\n)?\/\/# sourceURL=([^\r\n]+)(?:\r?\n)?$/

        const comboSearch = new Function('PLUGIN_ROUTE', `${liftText('comboSearch')}; return comboSearch`)(PLUGIN_ROUTE)
        const comboUrl = new Function('PLUGIN_ROUTE', 'comboSearch', `${liftText('comboUrl')}; return comboUrl`)(PLUGIN_ROUTE, comboSearch)
        const framedHash = new Function('createHash', 'HASH_REVISION_LENGTH', `${liftText('framedHash')}; return framedHash`)(createHash, HASH_REVISION_LENGTH)
        const newlineCount = new Function(`${liftText('newlineCount')}; return newlineCount`)()
        const prepareSource = new Function('SOURCE_URL_TRAILER', 'SOURCE_MAP_TRAILER', `${liftText('prepareSource')}; return prepareSource`)(SOURCE_URL_TRAILER, SOURCE_MAP_TRAILER)
        const identitySectionMap = new Function('newlineCount', `${liftText('identitySectionMap')}; return identitySectionMap`)(newlineCount)
        const comboSectionMap = new Function(`${liftText('comboSectionMap')}; return comboSectionMap`)()
        const comboScript = new Function('Buffer', 'SOURCE_MAP_TRAILER', `${liftText('comboScript')}; return comboScript`)(Buffer, SOURCE_MAP_TRAILER)
        const lazyBody = new Function(`${liftText('lazyBody')}; return lazyBody`)()
        const comboRevision = new Function('framedHash', `${liftText('comboRevision')}; return comboRevision`)(framedHash)
        const buildComboScript = new Function('prepareSource', 'comboScript', `${liftText('buildComboScript')}; return buildComboScript`)(prepareSource, comboScript)
        const buildComboSourceMap = new Function(
          'prepareSource', 'identitySectionMap', 'comboSectionMap', 'newlineCount', 'Buffer',
          `${liftText('buildComboSourceMap')}; return buildComboSourceMap`,
        )(prepareSource, identitySectionMap, comboSectionMap, newlineCount, Buffer)

        return new Function(
          'comboRevision',
          'comboUrl',
          'lazyBody',
          'buildComboScript',
          'buildComboSourceMap',
          'comboSearch',
          `${text}; return buildCombo`,
        )(comboRevision, comboUrl, lazyBody, buildComboScript, buildComboSourceMap, comboSearch)
      }
    }
  }
  throw new Error(`${DSH_CLIENT_MODULES}: buildCombo never closes`)
})()

/** The definition text of one top-level helper, brace-matched. */
function liftText(name: string): string {
  const start = REGISTRY_SOURCE.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `${DSH_CLIENT_MODULES} no longer defines ${name}`)
  let depth = 0
  for (let pos = REGISTRY_SOURCE.indexOf('{', start); pos < REGISTRY_SOURCE.length; pos += 1) {
    if (REGISTRY_SOURCE[pos] === '{') depth += 1
    else if (REGISTRY_SOURCE[pos] === '}') {
      depth -= 1
      if (depth === 0) return REGISTRY_SOURCE.slice(start, pos + 1)
    }
  }
  throw new Error(`${DSH_CLIENT_MODULES}: ${name} never closes`)
}

const parseDshClient = new Function(`${liftText('optionalStringArray')}; ${liftText('parseDshClient')}; return parseDshClient`)()
const clientExportOf = lift('clientExportOf')

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(pkgDir, 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as Record<string, any>
const PACKAGE_NAME = pkg['name'] as string
const EXPECTED_BUNDLE = join(pkgDir, 'lib', 'client.js')
const BUILD_FIRST = 'run `npm run build` in plugin/ first: this spec reads the build output'

/** The same inode? `statSync().ino` is the filesystem's own answer, not a string guess. */
function isSameFile(a: string, b: string): boolean {
  const left = statSync(a)
  const right = statSync(b)
  return left.dev === right.dev && left.ino === right.ino
}

/** A copy of the real declaration, with one field replaced, handed to the real parser. */
function declaration(overrides: Record<string, unknown>): { pkg: Record<string, any>; path: string; dir: string; disposers: string[] } {
  const dir = mkdtempSync(join(tmpdir(), 'pstack-pkgjson-'))
  const path = join(dir, 'package.json')
  const value = { name: PACKAGE_NAME, exports: pkg['exports'], dsh: pkg['dsh'], ...overrides }
  writeFileSync(path, JSON.stringify(value, null, 2))
  return { pkg: value, path, dir, disposers: [dir] }
}

// ---------------------------------------------------------------------------------------------
// 1. The declaration: what this package promises the Host's scanner.
// ---------------------------------------------------------------------------------------------

test('the manifest declares dsh.client.platform "web", and the real parser accepts it', () => {
  // Truth: plugin/package.json, read with the real `parseDshClient`
  // (dsh-client-modules/lib/index.js:61-80). `resolveMeta` only counts a package as a client
  // package when `decl.platform === "web"` (`:714`), so a non-web platform is the quiet failure.
  const decl = parseDshClient(PACKAGE_NAME, pkg['dsh']?.['client'])
  assert.ok(decl !== undefined, `${pkgPath} declares no dsh.client, so the Host would never serve a client bundle`)
  assert.equal(decl.platform, 'web', `${pkgPath}: dsh.client.platform must be "web" (dsh-client-modules/lib/index.js:714)`)
  // `inject` is this page's real dependency: it asks the shell's slot registry for `slots`.
  assert.deepEqual(decl.inject, ['slots'], `${pkgPath}: the page needs the "slots" service`)
})

test('exports["./client"] resolves, through the real resolver, to a file that exists', () => {
  // Truth: plugin/package.json `exports`, resolved by the real `clientExportOf`
  // (dsh-client-modules/lib/index.js:171-181) and joined to the package dir the way
  // `resolveMeta` joins it (`:714-730`).
  const relative = clientExportOf(PACKAGE_NAME, pkg['exports'])
  assert.equal(typeof relative, 'string', `${pkgPath}: exports["./client"] must be a string or {default: string}`)

  const resolved = join(pkgDir, relative as string)
  assert.ok(
    existsSync(resolved),
    `${resolved} does not exist — ${BUILD_FIRST}. A declared-but-missing bundle is a MissingClientBundleError at activation (dsh-client-modules/lib/index.js:130-141, :809-821)`,
  )
  assert.ok(statSync(resolved).isFile(), `${resolved} is not a file`)
})

// ---------------------------------------------------------------------------------------------
// 2. The bytes: the resolved path *is* the built bundle, and carries the page's own markers.
// ---------------------------------------------------------------------------------------------

test('the resolved bundle is exactly plugin/lib/client.js', () => {
  const relative = clientExportOf(PACKAGE_NAME, pkg['exports']) as string
  const resolved = join(pkgDir, relative)
  assert.ok(existsSync(EXPECTED_BUNDLE), `${EXPECTED_BUNDLE} does not exist — ${BUILD_FIRST}`)
  // Compared by inode: a resolver that returned a stale copy, a source file, or a different build
  // output of the same size would still fail this.
  assert.ok(
    isSameFile(resolved, EXPECTED_BUNDLE),
    `exports["./client"] points at ${resolved}, but the page the harness and the human see is ${EXPECTED_BUNDLE}`,
  )
})

test('the bundle carries the markers the page registers under', () => {
  // Truth: plugin/src/client/client.ts, which builds the page root as
  // `{ 'data-pfleet-page': 'violins' }` (`:1604`) and each violin card as `{ 'data-pviolin': violin.id }`
  // (`:1351`). Both survive into the built file as object-literal keys, which is what the layout
  // gate and client.spec.ts select on.
  const source = readFileSync(EXPECTED_BUNDLE, 'utf8')
  for (const [attribute, value] of [
    ['data-pfleet-page', "'violins'"],
    ['data-pviolin', ''],
  ] as const) {
    assert.ok(source.includes(attribute), `${EXPECTED_BUNDLE} has no "${attribute}" — the page root would not be findable`)
    if (value !== '') assert.ok(source.includes(value), `${EXPECTED_BUNDLE} never sets ${attribute} to ${value}`)
  }
  // The source file is the authority for those names; if it moved, this spec is reading a stale one.
  const pageSource = readFileSync(join(pkgDir, 'src', 'client', 'client.ts'), 'utf8')
  assert.match(pageSource, /'data-pfleet-page':\s*'violins'/, 'plugin/src/client/client.ts no longer sets data-pfleet-page="violins"')
  assert.match(pageSource, /'data-pviolin':/, 'plugin/src/client/client.ts no longer sets data-pviolin')
})

// ---------------------------------------------------------------------------------------------
// 3. The factory contract, asserted on the bytes the route would actually serve.
// ---------------------------------------------------------------------------------------------

/**
 * The record shape `buildCombo` consumes (dsh-client-modules/lib/index.js:362-380).
 *
 * `scriptBody`/`sourceMapBody` are **lazy and asynchronous** in 0.2.0-rc.2: `lazyBody` memoizes
 * `Promise.resolve().then(produce)` and returns the promise, so the served bytes arrive through
 * `await`. (Before the change `script` was a Buffer property.) {@link servedScript} is the only
 * reader, so the await lives in one place.
 */
function comboOf(clientPath: string): any {
  const entry = { id: PACKAGE_NAME, url: '', rev: 'test' }
  return buildCombo([
    {
      entry,
      loaderName: PACKAGE_NAME,
      sourceKey: 'test',
      meta: { clientPath, external: [], immediately: false },
      bundle: readFileSync(clientPath),
      baseline: { path: clientPath, mtimeMs: 0, size: 0 },
    },
  ])
}

/** The combo's executable bytes, through the harness's own lazy accessor. */
async function servedScript(clientPath: string): Promise<string> {
  const body = comboOf(clientPath).scriptBody()
  assert.ok(typeof (body as any)?.then === 'function', 'scriptBody is no longer promise-returning; this spec\'s await assumption is stale')
  return (await body).toString('utf8')
}

test('the served combo URL has the shape the /plugins route is registered for', () => {
  const combo = comboOf(EXPECTED_BUNDLE)
  // `comboUrl` (dsh-client-modules/lib/index.js:207-215) and the route's own contract — verbatim,
  // not a looser matcher: a package the route cannot name is a package the browser never loads.
  assert.equal(combo.url, `/plugins/??${PACKAGE_NAME}/client.js&rev=${String(combo.rev)}`)
  assert.match(
    combo.url,
    /^\/plugins\/\?\?[^,]+\.js&rev=[0-9a-f]{12}$/,
    'the prefix route is registered at "/plugins" (dsh-client-modules/lib/index.js:541-551) and the rev is a 12-char content hash',
  )
})

test('the served script parses, carries no import/export statement and no "use strict" prologue', async () => {
  // `buildComboScript`/`buildCombo` concatenate bundles into one script body and prepend nothing,
  // so a bundle that is an ES module or that opens with a directive prologue breaks the combo it
  // lands in. The same three facts client.spec.ts asserts about the file are asserted here about
  // the bytes the route would answer with — that is the new information, not a duplicate.
  const script = await servedScript(EXPECTED_BUNDLE)

  assert.doesNotMatch(script, /^\s*(?:import|export)\b/m, 'a combo member must not be an ES module')
  assert.doesNotMatch(script, /^\s*["']use strict["']/, 'no directive prologue: these bundles are concatenated')
  assert.ok(script.includes(`loader.load(`), 'the served script must still register with the module loader')
  assert.ok(script.includes(`'${PACKAGE_NAME}'`), `the served script must register under the id "${PACKAGE_NAME}"`)

  // Parsing is a fact about the bytes, so ask V8 rather than a regex. The globals a top-level
  // bundle touches are stubbed; `fetch` is deliberately absent because the page only calls it
  // inside its render, and a top-level call would be a defect worth failing on.
  const registrations: { id: string; factory: unknown }[] = []
  const sandbox: Record<string, unknown> = {
    window: { __ModuleLoader__: { load: (registration: { id: string; factory: unknown }) => registrations.push(registration) } },
  }
  assert.doesNotThrow(() => {
    runInNewContext(script, sandbox)
  }, 'the served bytes must parse as a plain script')

  assert.equal(registrations.length, 1, 'the served bytes must register exactly one module')
  assert.equal(registrations[0]?.id, PACKAGE_NAME, 'the registered id is the package name the graph row uses')
  assert.equal(typeof registrations[0]?.factory, 'function', 'the loader materializes a factory, never a value')
})

test('the registered factory materializes to an object whose apply is callable', async () => {
  // The shell applies what the factory returns (`__DSH_BOOT__` rows are Cordis plugins), so a
  // factory returning undefined, or a face with no `apply`, is a plugin that silently does nothing.
  const script = await servedScript(EXPECTED_BUNDLE)
  const registrations: { id: string; factory: (require: (id: string) => unknown) => unknown }[] = []
  runInNewContext(script, {
    window: { __ModuleLoader__: { load: (registration: { id: string; factory: (require: (id: string) => unknown) => unknown }) => registrations.push(registration) } },
  })
  const factory = registrations[0]?.factory
  assert.equal(typeof factory, 'function')

  const required: string[] = []
  const face = factory((id: string) => {
    required.push(id)
    // Both are seeded by the shell before any plugin bundle runs; nothing else may be required.
    if (id === 'react') return { createElement: () => ({}), useState: () => [undefined, () => {}], useEffect: () => {} }
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return {}
    throw new Error(`the served bundle required "${id}", which the shell does not seed`)
  }) as { apply?: unknown; inject?: unknown }

  assert.deepEqual(required, ['react', '@deepseek-ai/dsh-client-ui-primitives'], 'the requires are the two the shell seeds')
  assert.ok(face !== null && typeof face === 'object', 'the factory must materialize to a module face')
  assert.equal(typeof face.apply, 'function', 'the face must expose a callable apply — the Cordis plugin shape')
})

test('bootInjections names this package in the graph it injects as __DSH_BOOT__', () => {
  // Truth: `bootInjections` (dsh-client-modules/lib/index.js:453-497) and the `compose` method (`:649-700`).
  // This is the shape the Host's index injection produces, so a row that never reaches it is a row
  // the browser never sees.
  const combo = comboOf(EXPECTED_BUNDLE)
  const entry = { id: PACKAGE_NAME, url: combo.url, rev: combo.rev, inject: ['slots'], external: [] }
  const graph = {
    rev: 'test',
    entries: [entry],
    batches: [
      { phase: 'bootstrap', url: '/plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=0', rev: '0', entries: ['@deepseek-ai/dsh-client-modules'] },
      { phase: 'application', url: combo.url, rev: combo.rev, entries: [PACKAGE_NAME] },
    ],
  }
  const rows = modules.bootInjections(graph) as { kind: string; name?: string; value?: any; src?: string }[]

  const global = rows.find((row) => row.kind === 'global' && row.name === '__DSH_BOOT__')
  assert.ok(global !== undefined, 'the graph must be injected as window.__DSH_BOOT__')
  const injected = global.value as { entries: { id: string }[]; batches: { entries: string[] }[] }
  assert.ok(
    injected.entries.some((row) => row.id === PACKAGE_NAME),
    `__DSH_BOOT__.entries does not name ${PACKAGE_NAME}; the Host would serve every plugin but this one`,
  )
  assert.ok(
    injected.batches.some((batch) => batch.entries.includes(PACKAGE_NAME)),
    `no batch carries ${PACKAGE_NAME}, so no <script> would ever request its bundle`,
  )

  // And the half of the rule a malformed value does not cover: the *absence* of the export. It is
  // undefined, not a throw (`clientExportOf`, :156-166) — and `resolveMeta` is what turns that
  // undefined into the error, at :655. Both arms are asserted, because "no export" being silent here
  // is exactly why the check has to live in `resolveMeta`.
  assert.equal(clientExportOf(PACKAGE_NAME, { '.': './lib/index.js' }), undefined, 'no ./client export reads as undefined')
  assert.equal(clientExportOf(PACKAGE_NAME, undefined), undefined, 'no exports field at all reads as undefined')
})

// ---------------------------------------------------------------------------------------------
// 4. The negative: the rules that must REJECT, driven through the real code.
// ---------------------------------------------------------------------------------------------

test('the real parser rejects a malformed dsh.client declaration', () => {
  // Truth: `parseDshClient` (dsh-client-modules/lib/index.js:61-80). Each throw below is one of
  // its own arms; none of these strings is re-implemented here. A parser that accepted any of
  // these would make the malformed declaration silent at activation instead of an AggregateError.
  assert.throws(() => parseDshClient(PACKAGE_NAME, 'web'), /must be a string|non-object/, 'a string declaration')
  assert.throws(() => parseDshClient(PACKAGE_NAME, null), /non-object/, 'a null declaration')
  assert.throws(() => parseDshClient(PACKAGE_NAME, 7), /non-object/, 'a numeric declaration')
  assert.throws(() => parseDshClient(PACKAGE_NAME, {}), /platform must be a string/, 'no platform')
  assert.throws(() => parseDshClient(PACKAGE_NAME, { platform: 42 }), /platform must be a string/, 'a numeric platform')
  assert.throws(() => parseDshClient(PACKAGE_NAME, { platform: 'web', inject: 'slots' }), /inject must be a string array/, 'a scalar inject')
  assert.throws(() => parseDshClient(PACKAGE_NAME, { platform: 'web', inject: ['slots', 3] }), /inject must be a string array/, 'an inject with a non-string')
  assert.throws(() => parseDshClient(PACKAGE_NAME, { platform: 'web', external: {} }), /external must be a string array/, 'an object external')
  assert.throws(() => parseDshClient(PACKAGE_NAME, { platform: 'web', immediately: 'yes' }), /immediately must be a boolean/, 'a non-boolean immediately')

  // The happy path, so the rejects above are not the only thing this parser has ever been asked:
  // the declaration this package actually ships is accepted, and normalizes to the three fields.
  assert.deepEqual(parseDshClient(PACKAGE_NAME, { platform: 'web', inject: ['slots'] }), { platform: 'web', inject: ['slots'] })
})

test('a bundle path that does not exist is a rejection, not an empty page', async () => {
  // The activation path itself, on this package's real declaration pointed at a path the build
  // never emitted. `initialBundleSnapshot` turns ENOENT into `MissingClientBundleError`
  // (dsh-client-modules/lib/index.js:809-821) and the constructor aggregates failures into
  // `ClientPackageCompositionError` (:107-120) — an AggregateError, thrown from the constructor
  // (:479). Reaching that code needs a Loader and a Service context, so what is called here is the
  // registry's own prototype method, with the two fields it reads supplied.
  const { ClientModuleRegistry } = modules
  const registry = Object.create(ClientModuleRegistry.prototype) as any
  registry.pkgMeta = new Map()
  registry.ctx = { logger: { warn: () => {}, error: () => {} } }

  // The registry resolves the package from the Loader entry's specifier against a base URL, which is
  // this package directory; make it find the manifest without touching the real profile.
  const located = { packageName: PACKAGE_NAME, path: pkgPath }
  registry.locatePkgJson = () => located

  const declared = parseDshClient(PACKAGE_NAME, pkg['dsh']?.['client'])
  assert.equal(declared.platform, 'web')

  const meta = registry.resolveMeta(PACKAGE_NAME, pathToFileURL(`${pkgDir}/`).href)
  assert.equal(meta?.meta.clientPath, EXPECTED_BUNDLE, 'the real resolver joins exports["./client"] to the package dir')
  assert.ok(existsSync(meta.meta.clientPath), 'and that path is the bundle on disk')

  // Now the same call with the export pointed at a file the build does not emit.
  const broken = mkdtempSync(join(tmpdir(), 'pstack-broken-'))
  try {
    writeFileSync(join(broken, 'package.json'), JSON.stringify({ name: PACKAGE_NAME, exports: { './client': './lib/gone.js' }, dsh: pkg['dsh'] }, null, 2))
    registry.locatePkgJson = () => ({ packageName: PACKAGE_NAME, path: join(broken, 'package.json') })
    const brokenMeta = registry.resolveMeta(PACKAGE_NAME, pathToFileURL(`${broken}/`).href)
    assert.equal(brokenMeta?.meta.clientPath, join(broken, 'lib', 'gone.js'))
    assert.equal(existsSync(brokenMeta.meta.clientPath), false, 'the fixture must point at nothing, or this test proves nothing')

    assert.throws(
      () => registry.initialBundleSnapshot(PACKAGE_NAME, brokenMeta.meta.clientPath),
      (error: any) => {
        assert.equal(error.name, 'Error')
        assert.match(error.message, /client bundle not found/, 'the real MissingClientBundleError sentence')
        assert.match(error.message, /run `pnpm run build` before launch/, 'and its recovery instruction')
        assert.equal(error.packageName, PACKAGE_NAME, 'structured data for activation-error grouping')
        assert.equal(error.clientPath, brokenMeta.meta.clientPath)
        return true
      },
      'a declared-but-missing bundle must throw, because that is what makes the page blank',
    )
  } finally {
    rmSync(broken, { recursive: true, force: true })
  }
})

test('the activation path reads the real manifest end to end and finds this bundle', () => {
  // The one call in this file that touches both halves at once: the shipped `package.json` in, the
  // absolute path of the built bundle out, through the registry's own `resolveMeta` — the same
  // method activation calls per Loader entry (`processOne` → `resolveSource`, :775-812).
  const { ClientModuleRegistry } = modules
  const registry = Object.create(ClientModuleRegistry.prototype) as any
  registry.pkgMeta = new Map()
  registry.ctx = { logger: { warn: () => {}, error: () => {} } }
  registry.locatePkgJson = () => ({ packageName: PACKAGE_NAME, path: pkgPath })

  const meta = registry.resolveMeta(PACKAGE_NAME, pathToFileURL(`${pkgDir}/`).href)
  assert.ok(meta !== null, `${pkgPath} is not recognized as a client package by the real scanner`)
  assert.equal(meta.packageName, PACKAGE_NAME)
  assert.deepEqual(meta.meta.inject, ['slots'])
  assert.deepEqual(meta.meta.external, [])
  assert.equal(meta.meta.immediately, false)
  assert.ok(isSameFile(meta.meta.clientPath, EXPECTED_BUNDLE), `the scanner resolved ${meta.meta.clientPath}, not the built bundle`)
})

test('a package that is not a client package resolves to null, never to a broken row', () => {
  // `resolveMeta` returns null for a package with no `dsh.client`, or one whose platform is not
  // "web" (`:713-716`) — the positive control for every rejection above: this is the *quiet* path,
  // and it must stay quiet.
  const { ClientModuleRegistry } = modules
  const registry = Object.create(ClientModuleRegistry.prototype) as any
  registry.pkgMeta = new Map()
  registry.ctx = { logger: { warn: () => {}, error: () => {} } }

  const dir = mkdtempSync(join(tmpdir(), 'pstack-nonclient-'))
  try {
    for (const [label, manifest] of [
      ['no dsh.client', { name: 'not-a-client', exports: { './client': './lib/client.js' } }],
      ['a node platform', { name: 'not-a-client', exports: { './client': './lib/client.js' }, dsh: { client: { platform: 'node' } } }],
    ] as const) {
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest, null, 2))
      registry.pkgMeta = new Map()
      registry.locatePkgJson = () => ({ packageName: 'not-a-client', path: join(dir, 'package.json') })
      assert.equal(registry.resolveMeta('not-a-client', pathToFileURL(`${dir}/`).href), null, `${label} must not become a graph row`)
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// The temp-file discipline: the fixture builders above must not leave the directory open.
// ---------------------------------------------------------------------------------------------

test('the spec cleans up the package.json fixtures it writes', () => {
  const fixture = declaration({})
  try {
    const handle = openSync(fixture.path, 'r')
    closeSync(handle)
    assert.ok(existsSync(fixture.path))
  } finally {
    rmSync(fixture.dir, { recursive: true, force: true })
  }
  assert.equal(existsSync(fixture.dir), false)
})
