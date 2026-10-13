/**
 * The overlay read surface: `GET /api/pstack/overlay`.
 *
 * The route is read-only. Writes go through `/api/pstack/fleet`
 * (`tests/fleet-http.spec.ts`), which derives this file from the fleet groups file; a write here
 * would be reverted by the next reconciliation, so the route answers `405` and names where to go.
 *
 * These are rung 4 checks — they call the real handlers, the real `loadOverlayFile` reader, the
 * real parser and the real atomic writer against a temporary directory, with fakes only for
 * `ctx.webServer` / `ctx.settings` (the pattern `tests/apply.spec.ts` establishes). What they
 * cannot prove is that a live Host serves the route; that is the live section of the report.
 *
 * The fixture catalog carries the efforts **this machine's adapter really advertises**
 * (`off, low, high, max`, read from a live catalog capture), because
 * ACCEPTANCE 2 asks for all four to be accepted on write and one that is not there to be refused.
 * The model slugs in that fixture are the four real ones for the same reason: those are the
 * built-in names' routes and the built-in claim is worth nothing against invented slugs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  apply,
  BOOT_MARKER,
  FLEET_ROUTE_PATH,
  OVERLAY_FILE_MODE,
  OVERLAY_ROUTE_PATH,
  serializeOverlay,
} from '../src/index.ts'
import type { Config, OverlayFileV2, PluginContext } from '../src/index.ts'
import { loadOverlayFile } from '../src/roles/resolver.ts'
import { BUILT_IN_MODEL_NAMES, INHERIT_PARENT_MODEL, PANEL_ROLES, parseOverlay, ROLE_KEYS } from '../src/roles/overlay.ts'
import type { RouteCatalog } from '../src/roles/catalog.ts'
import {
  buildOverlayView,
  createOverlayRoute,
  handleOverlayGet,
  readModelSelection,
  validateOverlayAgainstCatalog,
  writeTextAtomic,
} from '../src/settings/http.ts'
import type {
  HttpRequestLike,
  HttpResponseLike,
  OverlayHttpSources,
  TaskView,
  WebRouteLike,
  WebServerLike,
} from '../src/settings/http.ts'
import type { ToolDefinitionLike } from '../src/tools/status.ts'
import type { SkillProvider, SkillProviderControl } from '../src/skills/provider.ts'
import type { AgentRequestListener } from '../src/effort.ts'

/**
 * The routes this machine's adapter enumerates, with the efforts it advertises on each one:
 * `off, low, high, max`. Read from the live catalog, not remembered.
 */
const CATALOG: RouteCatalog = {
  routes: [
    {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      efforts: ['off', 'low', 'high', 'max'],
      defaultEffort: 'high',
      credentialRef: 'DEEPSEEK_API_KEY',
      credentialSource: 'declared',
    },
    {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      efforts: ['off', 'low', 'high', 'max'],
      defaultEffort: 'high',
      credentialRef: 'DEEPSEEK_API_KEY',
      credentialSource: 'declared',
    },
    {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      efforts: ['off', 'low', 'high', 'max'],
      defaultEffort: 'high',
      credentialRef: 'DEEPSEEK_API_KEY',
      credentialSource: 'derived',
    },
    {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash-vision-exp',
      efforts: ['off', 'low', 'high', 'max'],
      defaultEffort: 'high',
      credentialRef: 'DEEPSEEK_API_KEY',
      credentialSource: 'declared',
    },
  ],
  unavailable: [{ provider: 'pi-ai', why: 'credential "PI_API_KEY" is not configured' }],
}

/** A version 2 document: two named models, a scalar task and a panel task. */
const V2: OverlayFileV2 = {
  version: 2,
  models: {
    main: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off', description: 'the default; most tasks' },
    smart: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
  },
  tasks: {
    feature: ['main'],
    'arena-runners': ['smart', 'main'],
  },
}

/** The sources the handlers read, with the real file reader and the real parser. */
function sourcesIn(dir: string, overrides: Partial<OverlayHttpSources> = {}): OverlayHttpSources {
  const overlayPath = join(dir, 'pstack.json')
  return {
    overlayPath,
    loadOverlay: () => loadOverlayFile(overlayPath),
    readOverlayText: async () => {
      try {
        return await readFile(overlayPath, 'utf8')
      } catch {
        return null
      }
    },
    catalog: async () => CATALOG,
    settings: { describe: () => [{ ns: 'subagent-model-selection', value: { enabled: false } }] },
    ...overrides,
  }
}

/** A request that emits its body once every handler has been attached. */
function fakeRequest(method: string, url = OVERLAY_ROUTE_PATH, body = ''): HttpRequestLike {
  const handlers: Record<string, ((value: never) => void)[]> = { data: [], end: [], error: [] }
  let scheduled = false
  return {
    method,
    url,
    on(event: string, listener: (value: never) => void) {
      handlers[event]?.push(listener)
      if (!scheduled) {
        scheduled = true
        setTimeout(() => {
          if (body.length > 0) for (const handler of handlers['data'] ?? []) handler(Buffer.from(body) as never)
          for (const handler of handlers['end'] ?? []) handler(undefined as never)
        }, 0)
      }
      return undefined
    },
  }
}

/** A response that records what was written. */
function fakeResponse(): HttpResponseLike & { readonly headers: Record<string, string>; body: string } {
  const headers: Record<string, string> = {}
  return {
    statusCode: 0,
    headers,
    body: '',
    setHeader(name, value) {
      headers[name.toLowerCase()] = value
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

/** Drive one route end to end and return the decoded response. */
async function call(route: WebRouteLike, req: HttpRequestLike): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> }> {
  const res = fakeResponse()
  await route.handler(req, res)
  return {
    status: res.statusCode,
    headers: res.headers,
    body: JSON.parse(res.body === '' ? '{}' : res.body) as Record<string, unknown>,
  }
}

/** A temporary directory for one test, removed afterwards. */
async function withDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'pstack-http-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** The task rows of a view, keyed. */
function taskRows(view: Record<string, unknown>): Map<string, TaskView> {
  return new Map(((view['tasks'] as TaskView[]) ?? []).map((task) => [task.key, task]))
}

// ---------------------------------------------------------------------------------------------
// GET: the two-level view.
// ---------------------------------------------------------------------------------------------

test('GET answers the named models, the task view, the live catalog and no overlay when there is none', async () => {
  await withDir(async (dir) => {
    const result = await handleOverlayGet(sourcesIn(dir))
    assert.equal(result.status, 200)
    const view = result.body as Record<string, unknown>

    assert.equal(view['overlayPath'], join(dir, 'pstack.json'))
    assert.equal(view['overlay'], null, 'no file yet: the parsed overlay is null, not an error')
    assert.equal(view['overlayText'], null)
    assert.equal(view['overlayError'], null)
    assert.equal(view['overlayVersion'], null)
    assert.equal(view['versionNote'], null)
    assert.deepEqual(view['catalog'], CATALOG)
    assert.deepEqual(view['unavailable'], CATALOG.unavailable)
    assert.deepEqual(view['taskKeys'], [...ROLE_KEYS])
    assert.deepEqual(view['roleKeys'], [...ROLE_KEYS])
    assert.deepEqual(view['panelRoles'], [...PANEL_ROLES])
    assert.deepEqual(view['models'], [], 'no file: nothing is declared, and no file means no built-in table')

    const tasks = taskRows(view)
    assert.equal(tasks.size, ROLE_KEYS.length)
    for (const key of ROLE_KEYS) {
      const task = tasks.get(key)
      assert.equal(task?.entry, 'inherit', `${key} has no overlay entry`)
      assert.equal(task?.resolved.length, 1)
      assert.equal(task?.resolved[0]?.inherit, true)
      assert.match(task?.resolved[0]?.reason ?? '', /inherits the parent's route/)
    }
    assert.deepEqual(
      [...tasks.values()].filter((task) => task.panel).map((task) => task.key),
      [...PANEL_ROLES],
    )
    assert.deepEqual(view['modelSelection'], {
      namespace: 'subagent-model-selection',
      present: true,
      enabled: false,
    })
  })
})

test('GET resolves each named model to its route and effort, and lists the tasks using it', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'pstack.json'), serializeOverlay(V2), 'utf8')
    const view = (await handleOverlayGet(sourcesIn(dir))).body as Record<string, unknown>
    assert.equal(view['overlayVersion'], 2)
    assert.equal(view['versionNote'], null)

    const models = view['models'] as {
      name: string
      builtIn: boolean
      declared: boolean
      inheritsParent: boolean
      route: { provider: string; model: string; reasoningEffort: string | null; efforts: string[]; defaultEffort: string | null } | null
      unavailable: string | null
      overlayDescription: string | null
      usedBy: string[]
    }[]
    const byName = new Map(models.map((model) => [model.name, model]))

    // Declared names sort first, then the built-ins the file does not override.
    assert.deepEqual(
      models.map((model) => model.name),
      ['main', 'smart', 'fast', 'vision', 'inherit-parent'],
    )

    const main = byName.get('main')
    assert.equal(main?.declared, true)
    assert.equal(main?.builtIn, true, 'main is a built-in name the file overrides, so both flags are true')
    assert.deepEqual(main?.route, {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'off',
      efforts: ['off', 'low', 'high', 'max'],
      defaultEffort: 'high',
      description: null,
    })
    assert.equal(main?.overlayDescription, 'the default; most tasks')
    assert.deepEqual(main?.usedBy, ['arena-runners', 'feature'])

    // A built-in the file says nothing about still resolves, from the adapter's own route list.
    const smart = byName.get('smart')
    assert.equal(smart?.declared, true)
    assert.equal(smart?.builtIn, true)
    assert.deepEqual(smart?.usedBy, ['arena-runners'])
    const fast = byName.get('fast')
    assert.equal(fast?.declared, false)
    assert.equal(fast?.builtIn, true)
    assert.equal(fast?.route?.model, 'deepseek-v4-flash')
    assert.equal(fast?.route?.reasoningEffort, 'low')
    assert.deepEqual(fast?.usedBy, [])
    assert.equal(byName.get('vision')?.route?.model, 'deepseek-v4-flash-vision-exp')

    // The sentinel is a legitimate name a task may point at, and it is not a route.
    const sentinel = byName.get(INHERIT_PARENT_MODEL)
    assert.equal(sentinel?.inheritsParent, true)
    assert.equal(sentinel?.route, null)
    assert.equal(sentinel?.unavailable, null)
  })
})

test('GET states a task pointing at one name, and a panel task fanning out over several', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'pstack.json'), serializeOverlay(V2), 'utf8')
    const view = (await handleOverlayGet(sourcesIn(dir))).body as Record<string, unknown>
    const tasks = taskRows(view)

    const feature = tasks.get('feature')
    assert.equal(feature?.panel, false)
    assert.equal(feature?.entry, 'models')
    assert.deepEqual(feature?.models, [{ name: 'main', known: true }])
    assert.equal(feature?.inheritsParent, false)
    assert.equal(feature?.resolved.length, 1)
    assert.deepEqual(feature?.resolved[0]?.route, {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'off',
    })

    // ACCEPTANCE 3: one resolution per name, in order, each with a distinct routeIndex — the
    // contract `pstack_spawn_panel` already consumes.
    const panel = tasks.get('arena-runners')
    assert.equal(panel?.panel, true)
    assert.deepEqual(panel?.models, [
      { name: 'smart', known: true },
      { name: 'main', known: true },
    ])
    assert.deepEqual(panel?.resolved.map((entry) => entry.routeIndex), [0, 1])
    assert.deepEqual(panel?.resolved.map((entry) => entry.route?.model), ['deepseek-v4-pro', 'deepseek-flash'])
    assert.deepEqual(panel?.resolved.map((entry) => entry.route?.reasoningEffort), ['max', 'off'])

    const absent = tasks.get('hillclimb')
    assert.equal(absent?.entry, 'absent')
    assert.equal(absent?.inheritsParent, true)
    assert.equal(absent?.resolved[0]?.inherit, true)
  })
})

test('GET reports a version 1 file as everything inherits, with the routes it no longer applies', async () => {
  await withDir(async (dir) => {
    await writeFile(
      join(dir, 'pstack.json'),
      '{"version":1,"roles":{"feature":{"routes":[{"provider":"deepseek-official","model":"deepseek-v4-pro"}]}}}',
      'utf8',
    )
    const view = (await handleOverlayGet(sourcesIn(dir))).body as Record<string, unknown>
    assert.equal(view['overlayVersion'], 1)
    assert.match(String(view['versionNote']), /this is a version 1 overlay/)
    assert.match(String(view['versionNote']), /routes for "feature", and those routes are NOT applied/)
    assert.deepEqual(view['models'], [], 'v1 names no models, so the model level is empty rather than guessed')
    const feature = taskRows(view).get('feature')
    assert.equal(feature?.entry, 'inherit')
    assert.equal(feature?.inheritsParent, true)
    assert.equal(feature?.resolved[0]?.inherit, true)
    assert.equal(feature?.resolved[0]?.reason, 'overlay is version 1; every task inherits the parent\'s route')
  })
})

test('GET reports an assignment the live catalog cannot honour instead of pretending it resolves', async () => {
  await withDir(async (dir) => {
    await writeFile(
      join(dir, 'pstack.json'),
      serializeOverlay({
        version: 2,
        models: { ghost: { provider: 'ghost-vendor', model: 'ghost-model' } },
        tasks: { feature: ['ghost'] },
      }),
      'utf8',
    )
    const view = (await handleOverlayGet(sourcesIn(dir))).body as Record<string, unknown>
    const ghost = (view['models'] as { name: string; route: unknown; unavailable: string | null }[])[0]
    assert.equal(ghost?.name, 'ghost')
    assert.equal(ghost?.route, null)
    assert.match(ghost?.unavailable ?? '', /ghost-vendor\/ghost-model is not in the live catalog/)
    const feature = taskRows(view).get('feature')
    assert.equal(feature?.resolved[0]?.inherit, true)
    assert.match(feature?.resolved[0]?.reason ?? '', /^unavailable: /)
  })
})

test('GET reports an unparseable overlay file instead of hiding it', async () => {
  await withDir(async (dir) => {
    await writeFile(join(dir, 'pstack.json'), '{ this is not json', 'utf8')
    const view = (await handleOverlayGet(sourcesIn(dir))).body as Record<string, unknown>
    assert.equal(view['overlay'], null)
    assert.equal(view['overlayVersion'], null)
    assert.match(String(view['overlayError']), /not valid JSON/)
    // The raw text still travels, so the editor repairs the file instead of replacing it blindly.
    assert.equal(view['overlayText'], '{ this is not json')
  })
})

test('writeTextAtomic replaces the target in one step and narrows a wider-permission file', async () => {
  await withDir(async (dir) => {
    const target = join(dir, 'nested', 'overlay.json')
    await writeTextAtomic(target, '{}\n')
    assert.equal(await readFile(target, 'utf8'), '{}\n')
    const info = await stat(target)
    assert.equal(info.mode & 0o777, OVERLAY_FILE_MODE)
    await writeTextAtomic(target, '{"version":2}\n')
    assert.equal(await readFile(target, 'utf8'), '{"version":2}\n')
  })
})

test('the route checks req.method itself: GET answers, a write is refused and names the fleet route', async () => {
  await withDir(async (dir) => {
    const route = createOverlayRoute(sourcesIn(dir))
    assert.equal(route.kind, 'exact')
    assert.equal(route.path, OVERLAY_ROUTE_PATH)

    const get = await call(route, fakeRequest('GET', `${OVERLAY_ROUTE_PATH}?refresh=1`))
    assert.equal(get.status, 200)
    assert.equal(get.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(get.headers['cache-control'], 'no-store')

    // The write half is gone on purpose: the overlay is a projection of the groups file now, and a
    // write here would answer 200 and then be reverted. Both verbs that used to write are refused,
    // and the refusal says where writes live.
    const put = await call(route, fakeRequest('PUT', OVERLAY_ROUTE_PATH, serializeOverlay({ version: 2, models: {}, tasks: {} })))
    assert.equal(put.status, 405)
    assert.equal(put.headers['allow'], 'GET')
    assert.match(String(put.body['error']), /Writes go to \/api\/pstack\/fleet/)

    const post = await call(route, fakeRequest('POST', OVERLAY_ROUTE_PATH, '{}'))
    assert.equal(post.status, 405)
    assert.equal(post.headers['allow'], 'GET')
    assert.match(String(post.body['error']), /POST is not supported/)
  })
})

// ---------------------------------------------------------------------------------------------
// The validator on its own, and the pieces around it.
// ---------------------------------------------------------------------------------------------

test('validateOverlayAgainstCatalog reports every problem, not the first', () => {
  const result = validateOverlayAgainstCatalog(
    {
      version: 2,
      models: {
        bad: { provider: 'nope', model: 'nope' },
        slow: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'medium' },
      },
      tasks: { feature: ['bad'], 'arena-runners': ['slow'] },
    },
    CATALOG,
  )
  assert.equal(result.ok, false)
  const problems = result.ok ? [] : result.problems
  // Four: each bad model is reported once where it is declared and once where it is used, because
  // the two reports answer different questions ("is this name correct?" vs "what runs here?").
  assert.equal(problems.length, 4)
  assert.match(problems[0] ?? '', /^model "bad": nope\/nope is not in the live catalog/)
  assert.match(problems[1] ?? '', /^model "slow": .* does not advertise reasoningEffort "medium"/)
  assert.match(problems[2] ?? '', /^task "feature": model "bad" — nope\/nope is not in the live catalog/)
  assert.match(problems[3] ?? '', /^task "arena-runners": model "slow" — .* does not advertise reasoningEffort "medium"/)
})

test('validateOverlayAgainstCatalog refuses a scalar task holding two names, and reports an unknown one', () => {
  // Both shapes the parser already refuses, asserted here as well because this function is the
  // gate a hand-built document reaches without passing through `parseOverlay`.
  const twoNames = validateOverlayAgainstCatalog(
    { version: 2, models: { main: { provider: 'deepseek-official', model: 'deepseek-flash' } }, tasks: { feature: ['main', 'main'] } },
    CATALOG,
  )
  assert.equal(twoNames.ok, false)
  assert.match(twoNames.ok ? '' : (twoNames.problems[0] ?? ''), /^task "feature": lists 2 model names but "feature" is not a panel role/)

  const unknown = validateOverlayAgainstCatalog(
    { version: 2, models: {}, tasks: { feature: ['nobody'] } },
    CATALOG,
  )
  assert.equal(unknown.ok, false)
  assert.match(unknown.ok ? '' : (unknown.problems[0] ?? ''), /^task "feature": names the model "nobody", which is neither built-in nor declared/)
})

test('validateOverlayAgainstCatalog accepts the four advertised efforts and the built-in names', () => {
  for (const effort of ['off', 'low', 'high', 'max']) {
    const result = validateOverlayAgainstCatalog(
      {
        version: 2,
        models: { main: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: effort } },
        tasks: { feature: ['main'], 'arena-runners': ['smart', INHERIT_PARENT_MODEL] },
      },
      CATALOG,
    )
    assert.equal(result.ok, true, `${effort} was refused: ${result.ok ? '' : result.problems.join('; ')}`)
  }
  // Every built-in name resolves against this catalog, so any task may point at any of them.
  for (const builtIn of BUILT_IN_MODEL_NAMES) {
    const result = validateOverlayAgainstCatalog({ version: 2, models: {}, tasks: { feature: [builtIn] } }, CATALOG)
    assert.equal(result.ok, true, `${builtIn} was refused: ${result.ok ? '' : result.problems.join('; ')}`)
  }
})

test('validateOverlayAgainstCatalog keeps the version 1 rules for a version 1 document', () => {
  const result = validateOverlayAgainstCatalog(
    {
      version: 1,
      roles: {
        feature: { routes: [{ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'medium' }] },
        bug: { routes: [{ provider: 'nope', model: 'nope' }] },
      },
    },
    CATALOG,
  )
  assert.equal(result.ok, false)
  assert.equal(result.ok ? 0 : result.problems.length, 2)
  assert.match(result.ok ? '' : (result.problems[0] ?? ''), /^role "feature" route 1: .* does not advertise reasoningEffort "medium"/)
})

test('readModelSelection reports absence and false as different facts, and never writes', () => {
  assert.deepEqual(readModelSelection(undefined), {
    namespace: 'subagent-model-selection',
    present: false,
    enabled: null,
  })
  // The face carries NO namespace: `describe()` lists nothing, so the row is absent.
  assert.deepEqual(readModelSelection({ describe: () => [] }), {
    namespace: 'subagent-model-selection',
    present: false,
    enabled: null,
  })
  // The namespace IS registered and its resolved value carries `enabled` — read through
  // `describe()[].value`, which is the only read `SettingsForms` offers.
  assert.deepEqual(
    readModelSelection({
      describe: () => [
        { ns: 'subagent-model-selection', value: { enabled: true, allowedModels: [] } },
      ],
    }),
    { namespace: 'subagent-model-selection', present: true, enabled: true },
  )
  // A read that throws must degrade to "absent", not propagate.
  assert.deepEqual(
    readModelSelection({
      describe: () => {
        throw new Error('sealed')
      },
    }),
    { namespace: 'subagent-model-selection', present: false, enabled: null },
  )
})

test('buildOverlayView asks for a fresh catalog when told to refresh', async () => {
  await withDir(async (dir) => {
    const asked: (boolean | undefined)[] = []
    await buildOverlayView(
      sourcesIn(dir, {
        catalog: async (refresh?: boolean) => {
          asked.push(refresh)
          return CATALOG
        },
      }),
      true,
    )
    assert.deepEqual(asked, [true])
  })
})

// ---------------------------------------------------------------------------------------------
// `apply()` wiring: the route reaches `ctx.webServer` through Cordis's optional-dependency form.
// ---------------------------------------------------------------------------------------------

interface Wiring {
  readonly ctx: Parameters<typeof apply>[0]
  readonly routes: WebRouteLike[]
  readonly injected: string[][]
  readonly effects: number
  readonly disposals: number
  readonly lines: string[]
}

/**
 * A context that records what `apply` registers.
 *
 * `mode: 'provided'` gives the fake `ctx.inject` a recording web server; `'absent'` gives it a
 * child context whose `get('webServer')` answers `undefined`, which is the "service present but
 * unreadable" branch.
 */
function wireRecorder(mode: 'provided' | 'absent'): Wiring {
  const routes: WebRouteLike[] = []
  const injected: string[][] = []
  const lines: string[] = []
  let effects = 0
  let disposals = 0
  const webServer: WebServerLike | undefined =
    mode === 'provided'
      ? {
          register: (route) => {
            routes.push(route)
            return () => {}
          },
        }
      : undefined
  const child = {
    get: (name: string): unknown => (name === 'webServer' ? webServer : undefined),
  }
  const recording: Wiring = {
    routes,
    injected,
    get effects() {
      return effects
    },
    get disposals() {
      return disposals
    },
    lines,
    ctx: {
      logger: { info: (message) => lines.push(message), warn: (message) => lines.push(message) },
      skills: { registerProvider: (_create: (control: SkillProviderControl) => SkillProvider) => () => {} },
      tools: { register: (_definition: ToolDefinitionLike) => () => {} },
      subagents: { start: async () => ({}) },
      llm: { listProviders: () => [], listModels: async () => [], resolveModelInfo: async () => ({ reasoning: { efforts: [] } }) },
      credentials: { describe: async () => ({ configured: false }) },
      settings: { describe: () => [] },
      on: (_event: string, _listener: AgentRequestListener) => () => {},
      inject: (deps, callback) => {
        injected.push([...deps])
        callback(child as never)
        return () => {}
      },
      get: child.get,
      effect: (callback) => {
        effects += 1
        const dispose = callback()
        if (typeof dispose === 'function') disposals += 1
        return dispose
      },
    } as unknown as Parameters<typeof apply>[0],
  }
  return recording
}

test('apply() registers both routes when webServer is provided, through ctx.effect', () => {
  const wire = wireRecorder('provided')
  apply(wire.ctx, { overlayPath: '/nonexistent/pstack.json', registerSkills: false } satisfies Config)

  // `webServer` is the only optional face now. Until 2026-10-13 `settings` was requested here too,
  // for a namespace registration that DSH 0.2.0-rc.2 does not support — `ctx.settings.register` and
  // `installSection` exist nowhere in the installed harness, so that callback only logged a warning.
  // The page never needed it: it registers its own `settings.section` slot and reads the fleet route.
  assert.deepEqual(
    wire.injected,
    [['webServer']],
    'the data route needs webServer, requested in its optional form',
  )
  assert.deepEqual(
    wire.routes.map((route) => route.path),
    [OVERLAY_ROUTE_PATH, FLEET_ROUTE_PATH],
    'the read surface and the write surface, in that order',
  )
  for (const route of wire.routes) assert.equal(route.kind, 'exact')
  assert.equal(wire.effects, 1, 'both registrations are bound to the plugin lifecycle')
  assert.equal(wire.disposals, 1, 'and one disposer tears both down')
  assert.ok(
    wire.lines.some((line) => line.includes(`${BOOT_MARKER} http registered paths=${OVERLAY_ROUTE_PATH},${FLEET_ROUTE_PATH}`)),
    `an unlogged registration is not evidence; lines were: ${wire.lines.join(' | ')}`,
  )
})

test('apply() names the route it would register in the marker line, and warns when the service is unreadable', () => {
  const wire = wireRecorder('absent')
  apply(wire.ctx, { overlayPath: '/nonexistent/pstack.json', registerSkills: false })
  assert.equal(wire.routes.length, 0)
  assert.ok(
    wire.lines.some((line) => line.includes(`httpRoute=${OVERLAY_ROUTE_PATH},${FLEET_ROUTE_PATH}`)),
    'the marker line must say which routes were intended',
  )
  assert.ok(wire.lines.some((line) => line.includes('could not be read')), 'and warn when the service is unusable')
})

test('registerHttp: false leaves the web server alone', () => {
  const wire = wireRecorder('provided')
  apply(wire.ctx, { overlayPath: '/nonexistent/pstack.json', registerSkills: false, registerHttp: false })
  assert.deepEqual(wire.injected, [])
  assert.ok(wire.lines.some((line) => line.includes('httpRoute=none')))
})

test('a context with no inject at all still applies: the route is simply not registered', () => {
  const wire = wireRecorder('provided')
  const ctx = { ...(wire.ctx as PluginContext) } as Record<string, unknown>
  delete ctx['inject']
  apply(ctx as unknown as PluginContext, { overlayPath: '/nonexistent/pstack.json', registerSkills: false })
  assert.equal(wire.routes.length, 0)
  assert.ok(wire.lines.some((line) => line.includes(BOOT_MARKER)))
})
