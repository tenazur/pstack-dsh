/**
 * Route enumeration against an injected `ctx.llm` face.
 *
 * The catalog is derived from the Host, never hardcoded. The real `ctx.llm`
 * cannot be constructed without a Host, so the face is a fake here — that is the whole point of
 * `enumerateRoutes(llm)` taking it as an argument rather than reading a context.
 *
 * ## What this file stopped testing, and why that is the point
 *
 * Most of what used to live here tested a **credential gate**: resolving each provider's declared
 * `apiKeyEnv` by guessing settings namespaces, with retries, a directory join and three fallback
 * tiers. That machinery was deleted on 2026-10-13, and so were its tests, because it made a claim
 * this layer cannot support — it **omitted** models on the theory that they could not
 * authenticate, and when its guess lost it returned an empty catalog on a correctly configured
 * install. Silence, not an error.
 *
 * `enumerateRoutes` now lists what is registered and reports only registration facts. So this file
 * asserts: every registered model appears, adapter order is kept, an adapter's own failures are
 * reported rather than thrown, and a dormant provider is still named with its reason. Whether a
 * route has a key is the adapter's business, at spawn time, in the adapter's own words.
 *
 * Every slug in this file is obviously fake (`test-provider`, `test-model`, ...). A real slug
 * (`deepseek-official/deepseek-flash`) is an install fact, not a fixture, and hardcoding one is
 * how a port ships a config that lies (`plugin/HARNESS.md` §Rules 2).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { enumerateRoutes, findRoute, unavailableReason } from '../src/roles/catalog.ts'
import { createRoleResolver, loadOverlayFile } from '../src/roles/resolver.ts'
import type {
  LlmCatalogLike,
  LlmConfigurableProviderLike,
  LlmModelInfoLike,
  LlmProviderInfoLike,
  LlmResolvedModelInfoLike,
  RouteCatalog,
} from '../src/roles/catalog.ts'
import type { OverlayFile } from '../src/roles/overlay.ts'

/** The effort ids a fake adapter advertises; objects, as `resolveModelInfo` really returns them. */
const EFFORTS = [
  { id: 'off', name: 'Off' },
  { id: 'low', name: 'Low' },
  { id: 'high', name: 'High' },
  { id: 'max', name: 'Max' },
]

/** A fake `ctx.llm`; records every provider it was asked to enumerate models for. */
function fakeLlm(options: {
  providers?: readonly LlmProviderInfoLike[]
  models?: (provider: string) => readonly LlmModelInfoLike[]
  resolve?: (provider: string, model: string) => LlmResolvedModelInfoLike
  listModelsError?: string
  configurable?: readonly LlmConfigurableProviderLike[]
} = {}): LlmCatalogLike & { readonly asked: string[] } {
  const asked: string[] = []
  const providers = options.providers ?? [{ id: 'test-provider', name: 'Test Provider' }]
  const models =
    options.models ??
    ((provider: string): readonly LlmModelInfoLike[] => [{ provider, id: 'test-model', name: 'Test Model' }])
  const resolve =
    options.resolve ??
    ((): LlmResolvedModelInfoLike => ({ reasoning: { efforts: EFFORTS, defaultEffort: 'high' } }))
  return {
    asked,
    listProviders: () => providers,
    listModels: async (provider) => {
      asked.push(provider)
      if (options.listModelsError !== undefined) throw new Error(options.listModelsError)
      return models(provider)
    },
    resolveModelInfo: async (provider, model) => resolve(provider, model),
    ...(options.configurable === undefined ? {} : { listConfigurableProviders: () => options.configurable ?? [] }),
  }
}

// ---------------------------------------------------------------------------------------------
// The inventory is what is registered — no credential judgement anywhere in it.
// ---------------------------------------------------------------------------------------------

test('every model of every registered provider is enumerated, with the adapter order kept', async () => {
  const llm = fakeLlm({
    providers: [
      { id: 'test-provider', name: 'Test Provider' },
      { id: 'test-other', name: 'Test Other' },
    ],
    models: (provider) =>
      provider === 'test-provider'
        ? [
            { provider, id: 'test-model-a', name: 'A' },
            { provider, id: 'test-model-b', name: 'B' },
          ]
        : [{ provider, id: 'test-model-c', name: 'C' }],
  })

  const catalog = await enumerateRoutes(llm)

  assert.deepEqual(
    catalog.routes.map((route) => `${route.provider}/${route.model}`),
    ['test-provider/test-model-a', 'test-provider/test-model-b', 'test-other/test-model-c'],
    'provider order comes from listProviders, model order from listModels, nothing is filtered',
  )
  assert.deepEqual(catalog.unavailable, [], 'nothing is unusable merely for want of a credential')
  assert.deepEqual(llm.asked, ['test-provider', 'test-other'])
})

test('a model is listed with no credential face in scope to veto it', async () => {
  // The regression this file exists for. The deleted gate called `credentials.describe(ref)` and
  // dropped every model whose ref came back unconfigured. Two things were wrong with that: DSH has
  // no settings API to read the adapter's declared ref from, and the derived fallback
  // (`TEST_PROVIDER_API_KEY`) is a guess that can be wrong, so the gate dropped working models.
  // `enumerateRoutes` no longer takes a credentials face at all; this asserts the model survives,
  // which is the observable consequence of that signature.
  const llm = fakeLlm()
  const catalog = await enumerateRoutes(llm)
  assert.deepEqual(catalog.routes.map((route) => route.model), ['test-model'])
})

test('a route carries the efforts and default the adapter advertises', async () => {
  const catalog = await enumerateRoutes(fakeLlm())
  assert.deepEqual(catalog.routes[0]?.efforts, ['off', 'low', 'high', 'max'])
  assert.equal(catalog.routes[0]?.defaultEffort, 'high')
})

test('a route with no reasoning block is enumerated with no advertised efforts', async () => {
  const llm = fakeLlm({ resolve: () => ({}) })
  const catalog = await enumerateRoutes(llm)
  assert.deepEqual(catalog.routes.map((route) => route.model), ['test-model'])
  assert.deepEqual(catalog.routes[0]?.efforts, [])
  assert.equal(catalog.routes[0]?.defaultEffort, undefined)
})

test('an adapter description is carried verbatim, and absence stays absent', async () => {
  const described = await enumerateRoutes(
    fakeLlm({ resolve: () => ({ description: '  Fast, for bulk edits.  ', reasoning: { efforts: EFFORTS } }) }),
  )
  assert.equal(described.routes[0]?.description, 'Fast, for bulk edits.', 'trimmed, but the adapter’s own words')

  const silent = await enumerateRoutes(fakeLlm({ resolve: () => ({ description: '   ' }) }))
  assert.equal(silent.routes[0]?.description, undefined, 'whitespace is not a description')
})

// ---------------------------------------------------------------------------------------------
// Registration facts are still reported. Only credentials were dropped.
// ---------------------------------------------------------------------------------------------

test('listModels failing is an unavailable entry, not a thrown enumeration', async () => {
  const catalog = await enumerateRoutes(fakeLlm({ listModelsError: 'adapter is not configured' }))
  assert.deepEqual(catalog.routes, [])
  assert.equal(catalog.unavailable.length, 1)
  assert.equal(catalog.unavailable[0]?.provider, 'test-provider')
  assert.match(catalog.unavailable[0]?.why ?? '', /cannot list models: adapter is not configured/)
})

test('a model whose resolveModelInfo throws is reported model-level with the adapter’s message', async () => {
  const llm = fakeLlm({
    models: (provider) => [
      { provider, id: 'test-good', name: 'Good' },
      { provider, id: 'test-bad', name: 'Bad' },
    ],
    resolve: (_provider, model) => {
      if (model === 'test-bad') throw new Error('adapter says no')
      return { reasoning: { efforts: EFFORTS } }
    },
  })

  const catalog = await enumerateRoutes(llm)

  assert.deepEqual(catalog.routes.map((route) => route.model), ['test-good'], 'one bad model does not lose the provider')
  assert.deepEqual(catalog.unavailable, [
    { provider: 'test-provider', model: 'test-bad', why: 'resolveModelInfo failed: adapter says no' },
  ])
})

test('a declared-but-dormant provider is reported unavailable with its settings namespace', async () => {
  const catalog = await enumerateRoutes(
    fakeLlm({
      configurable: [{ provider: 'test-dormant', displayName: 'Dormant', settingsNs: 'llm-dormant', settingsPath: [] }],
    }),
  )
  assert.equal(catalog.unavailable.length, 1)
  assert.equal(catalog.unavailable[0]?.provider, 'test-dormant')
  assert.match(catalog.unavailable[0]?.why ?? '', /declared by an adapter \(settings namespace "llm-dormant"\)/)
})

test('a provider that is registered is not also reported dormant, even if the directory lists it', async () => {
  // The directory is not a route list: on this machine it omits registered providers entirely, so
  // treating it as authoritative would hide routes. Where it does name a registered provider, the
  // provider must not be double-reported as unusable.
  const catalog = await enumerateRoutes(
    fakeLlm({
      configurable: [{ provider: 'test-provider', displayName: 'Test', settingsNs: 'llm-test', settingsPath: [] }],
    }),
  )
  assert.deepEqual(catalog.routes.map((route) => route.model), ['test-model'])
  assert.deepEqual(catalog.unavailable, [])
})

test('a directory that throws is a warning, not a failed enumeration', async () => {
  const warnings: string[] = []
  const llm = fakeLlm()
  const catalog = await enumerateRoutes(
    {
      ...llm,
      listConfigurableProviders: () => {
        throw new Error('directory exploded')
      },
    },
    { logger: { warn: (message) => warnings.push(message) } },
  )
  assert.deepEqual(catalog.routes.map((route) => route.model), ['test-model'], 'the routes still enumerate')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0] ?? '', /directory exploded/)
})

test('an aborted enumeration stops instead of returning a partial catalog', async () => {
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(
    () => enumerateRoutes(fakeLlm(), { signal: controller.signal }),
    (error: unknown) => (error as { name?: string }).name === 'AbortError',
  )
})

// ---------------------------------------------------------------------------------------------
// Catalog readers.
// ---------------------------------------------------------------------------------------------

test('findRoute and unavailableReason read one catalog consistently', () => {
  const catalog: RouteCatalog = {
    routes: [{ provider: 'test-provider', model: 'test-model', efforts: ['off'], defaultEffort: 'off' }],
    unavailable: [
      { provider: 'test-dormant', why: 'declared by an adapter but not registered' },
      { provider: 'test-provider', model: 'test-broken', why: 'resolveModelInfo failed: adapter says no' },
    ],
  }
  assert.equal(findRoute(catalog, 'test-provider', 'test-model')?.model, 'test-model')
  assert.equal(findRoute(catalog, 'test-provider', 'test-nope'), undefined)
  assert.equal(unavailableReason(catalog, 'test-provider', 'test-broken'), 'resolveModelInfo failed: adapter says no')
  assert.match(unavailableReason(catalog, 'test-dormant', 'test-dormant-model') ?? '', /not registered/)
  assert.equal(unavailableReason(catalog, 'test-provider', 'test-model'), undefined)
})

test('loadOverlayFile treats a missing overlay as no overlay and a broken one as an error', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'pstack-overlay-'))
  try {
    const missing = await loadOverlayFile(join(dir, 'pstack.json'))
    assert.deepEqual(missing, { ok: true, value: undefined })

    const brokenPath = join(dir, 'broken.json')
    await writeFile(brokenPath, '{"version":2,"roles":{}}', 'utf8')
    const broken = await loadOverlayFile(brokenPath)
    assert.equal(broken.ok, false)
    assert.match(broken.ok ? '' : broken.error, /version 2 has unknown top-level key "roles"/)

    const prosePath = join(dir, 'prose.json')
    await writeFile(
      prosePath,
      '{"version":2,"models":{"main":{"provider":"test-provider","model":"test-model"}},"tasks":{"judgment and prose":["main"]}}',
      'utf8',
    )
    const prose = await loadOverlayFile(prosePath)
    assert.ok(prose.ok)
    const value = prose.ok ? prose.value : undefined
    assert.deepEqual(Object.keys(value !== undefined && value.version === 2 ? value.tasks : {}), ['judgment-and-prose'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------------------------
// The resolver: one injected face, lazy enumeration, overlay re-read per resolve.
// ---------------------------------------------------------------------------------------------

test('createRoleResolver enumerates once, re-reads the overlay per resolve, and refreshes', async () => {
  const llm = fakeLlm()
  let reads = 0
  let overlay: OverlayFile = {
    version: 2,
    models: {
      main: { provider: 'test-provider', model: 'test-model' },
      alt: { provider: 'test-provider', model: 'test-model', reasoningEffort: 'low' },
    },
    tasks: {
      feature: ['main'],
      'arena-runners': ['main', 'alt'],
    },
  }
  const resolver = createRoleResolver({
    llm,
    readOverlay: async () => {
      reads += 1
      return overlay
    },
  })

  const feature = await resolver.resolve('feature')
  assert.equal(feature.inherit, false)
  assert.deepEqual(feature.route, { provider: 'test-provider', model: 'test-model' })

  const panelFirst = await resolver.resolve('arena-runners')
  const panelSecond = await resolver.resolve('arena-runners', 1)
  assert.deepEqual([panelFirst.routeIndex, panelSecond.routeIndex], [0, 1])
  assert.deepEqual(panelSecond.route, { provider: 'test-provider', model: 'test-model', reasoningEffort: 'low' })

  // One enumeration for three resolves (`asked` records listModels calls), one overlay read each.
  assert.deepEqual(llm.asked, ['test-provider'])
  assert.equal(reads, 3)

  // The overlay is not cached: an edit wins on the next resolve, as with a skill body.
  overlay = { version: 2, models: {}, tasks: {} }
  const afterEdit = await resolver.resolve('feature')
  assert.equal(afterEdit.inherit, true)

  // refresh() drops the cached catalog and asks the adapter again.
  await resolver.refresh()
  assert.deepEqual(llm.asked, ['test-provider', 'test-provider'])
})

test('a role mapped to a model the catalog never listed inherits, and says why', async () => {
  // Registration is still a real gate on the overlay: a mapping to a model no adapter registered
  // cannot be honoured. This is the case the route gate's `witness-ghost` seeds.
  const llm = fakeLlm()
  const resolver = createRoleResolver({
    llm,
    readOverlay: async () => ({
      version: 2,
      models: { main: { provider: 'test-provider', model: 'test-ghost' } },
      tasks: { feature: ['main'] },
    }),
  })
  const resolved = await resolver.resolve('feature')
  assert.equal(resolved.inherit, true, 'an unregistered model is not silently accepted')
})

test('a caller may inject an already-enumerated catalog instead of asking the adapter', async () => {
  const llm = fakeLlm()
  const catalog: RouteCatalog = {
    routes: [{ provider: 'test-injected', model: 'test-model', efforts: [] }],
    unavailable: [],
  }
  const resolver = createRoleResolver({
    llm,
    catalog,
    readOverlay: async () => ({
      version: 2,
      models: { main: { provider: 'test-injected', model: 'test-model' } },
      tasks: { feature: ['main'] },
    }),
  })
  const resolved = await resolver.resolve('feature')
  assert.equal(resolved.inherit, false)
  assert.deepEqual(llm.asked, [], 'the injected catalog is used as given, with no enumeration at all')
})
