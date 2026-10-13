/**
 * The fleet route: `GET`/`PUT /api/pstack/fleet`, the two files it keeps in step, and the write
 * gate that refuses a fleet the live catalog cannot honour.
 *
 * These are rung 4 checks over the real handlers, the real parser, the real projection and the real
 * atomic writer against a temporary directory, with fakes only for the catalog and the settings
 * face — the pattern `tests/settings-http.spec.ts` establishes. What they cannot prove is that a
 * live Host serves the route; that is the live section of the report.
 *
 * The fixture catalog carries **this machine's four real routes** and the efforts its adapter
 * really advertises (`off, low, high, max`), because the defaults' heuristic is only worth testing
 * against routes that exist. The session default is this machine's own (`deepseek-flash` at `off`,
 * `~/.dsh/settings.yaml`), which is what `general` must follow.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteCatalog } from '../src/roles/catalog.ts'
import { PANEL_ROLES, ROLE_KEYS, parseOverlay } from '../src/roles/overlay.ts'
import {
  PREDEFINED_VIOLIN_IDS,
  parseFleetGroups,
  serializeFleetGroups,
  withSelections,
  withTask,
} from '../src/roles/fleet-groups.ts'
import type { FleetGroupsFile, SessionDefaultRoute } from '../src/roles/fleet-groups.ts'
import {
  FLEET_ROUTE_PATH,
  GROUPS_FILE_MODE,
  MAX_FLEET_BODY_BYTES,
  createFleetRoute,
  handleFleetGet,
  handleFleetPut,
} from '../src/settings/fleet-http.ts'
import type { FleetHttpSources, FleetView } from '../src/settings/fleet-http.ts'
import type { HttpRequestLike, HttpResponseLike, WebRouteLike } from '../src/settings/http.ts'
import { loadOverlayFile } from '../src/roles/resolver.ts'
import { resolvePanel, resolveRole } from '../src/roles/overlay.ts'

/** The routes this machine's adapter enumerates, with the efforts it advertises on each one. */
const CATALOG: RouteCatalog = {
  routes: [
    { provider: 'deepseek-official', model: 'deepseek-flash', efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'max' },
    {
      provider: 'deepseek-official',
      model: 'deepseek-v4-flash',
      efforts: ['off', 'low', 'high', 'max'],
      defaultEffort: 'max',
      description: 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
    },
    {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      efforts: ['off', 'low', 'high', 'max'],
      defaultEffort: 'max',
      description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
    },
    { provider: 'deepseek-official', model: 'deepseek-v4-flash-vision-exp', efforts: ['off', 'low', 'high', 'max'], defaultEffort: 'max' },
  ],
  unavailable: [{ provider: 'pi-ai', why: 'credential "PI_API_KEY" is not configured' }],
}

/** This machine's session default: `deepseek-flash` at `off`. */
const SESSION_DEFAULT: SessionDefaultRoute = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'off' }

/** The sources the handlers read, with the real atomic writer against `dir`. */
function sourcesIn(dir: string, overrides: Partial<FleetHttpSources> = {}): FleetHttpSources {
  return {
    groupsPath: join(dir, 'pstack-fleet.json'),
    overlayPath: join(dir, 'pstack.json'),
    catalog: async () => CATALOG,
    sessionDefault: () => SESSION_DEFAULT,
    settings: { describe: () => [{ ns: 'subagent-model-selection', value: { enabled: false } }] },
    ...overrides,
  }
}

/** The view a handler answered with, or a failure naming what went wrong instead. */
function viewOf(result: { status: number; body: unknown }): FleetView {
  assert.equal(result.status, 200, `expected 200, got ${String(result.status)}: ${JSON.stringify(result.body)}`)
  return result.body as FleetView
}

/** The refusal a handler answered with. */
function refusalOf(result: { status: number; body: unknown }): { status: number; error: string; problems: readonly string[] } {
  const body = result.body as { error?: string; problems?: readonly string[] }
  assert.notEqual(result.status, 200, 'expected a refusal, got 200')
  return { status: result.status, error: body.error ?? '', problems: body.problems ?? [] }
}

/** Read a file's text, or `null` when it is not there. */
async function textAt(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** A request that emits its body once every handler has been attached. */
function fakeRequest(method: string, url = FLEET_ROUTE_PATH, body = ''): HttpRequestLike {
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
async function call(
  route: WebRouteLike,
  req: HttpRequestLike,
): Promise<{ status: number; headers: Record<string, string>; body: Record<string, unknown> }> {
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
  const dir = await mkdtemp(join(tmpdir(), 'pstack-fleet-'))
  try {
    await run(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------------------------------------
// Load: setup, import, reconciliation.
// ---------------------------------------------------------------------------------------------

test('a fresh install gets both files written, with the defaults and a legal overlay', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)
    const view = viewOf(await handleFleetGet(sources))

    assert.equal(view.origin, 'defaults')
    assert.ok(
      view.repairs.some((line) => line.includes('no fleet groups file and no overlay existed')),
      `the setup must say what it did; got ${view.repairs.join(' | ')}`,
    )
    assert.deepEqual(view.problems, [], 'the defaults are chosen from the catalog, so nothing is unhonourable')

    // Both files are on disk, and the groups file is the defaults verbatim.
    const groupsText = await textAt(sources.groupsPath)
    const overlayText = await textAt(sources.overlayPath)
    assert.ok(groupsText !== null && overlayText !== null, 'setup writes both files')
    const written = parseFleetGroups(groupsText)
    assert.equal(written.ok, true)
    assert.equal(serializeFleetGroups(view.groups), groupsText, 'and the file is what the view served')

    // The overlay is the projection: every task stated, comparison tasks fanning out over two names.
    const overlay = parseOverlay(overlayText)
    assert.equal(overlay.ok, true)
    if (!overlay.ok) return
    assert.deepEqual(Object.keys(overlay.value.version === 2 ? overlay.value.tasks : {}).sort(), [...ROLE_KEYS].sort())
    const arena = overlay.value.version === 2 ? overlay.value.tasks['arena-runners'] : undefined
    assert.deepEqual(arena, ['arena-runners-1', 'arena-runners-2'])
  })
})

test('an existing overlay is imported once, then the groups file wins', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)
    await writeFile(
      sources.overlayPath,
      `${JSON.stringify(
        {
          version: 2,
          models: { reviewer: { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' } },
          tasks: { feature: ['reviewer'] },
        },
        null,
        2,
      )}\n`,
    )

    const first = viewOf(await handleFleetGet(sources))
    assert.equal(first.origin, 'imported')
    assert.ok(first.repairs.some((line) => line.includes('imported the overlay')))
    assert.equal(first.groups.violins.find((v) => v.id === 'reviewer')?.origin, 'custom', 'a declared name arrives as a custom violin')
    assert.deepEqual(first.groups.violins.find((v) => v.id === 'reviewer')?.tasks, ['feature'])
    assert.ok(await textAt(sources.groupsPath), 'and the import is written out')

    // Second load: the file is now the source of truth, and nothing is imported again.
    const second = viewOf(await handleFleetGet(sources))
    assert.equal(second.origin, 'file')
    assert.deepEqual(second.repairs, [])
    assert.deepEqual(second.groups, first.groups)
  })
})

test('a disagreement between the files is repaired from the groups side, and reported', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)
    viewOf(await handleFleetGet(sources))
    // Hand-edit the overlay into something the groups file does not say.
    await writeFile(sources.overlayPath, '{"version":2,"models":{},"tasks":{}}\n')

    const repaired = viewOf(await handleFleetGet(sources))
    assert.ok(
      repaired.repairs.some((line) => line.includes('rewrote') && line.includes('the two had disagreed')),
      `the repair must be visible; got ${repaired.repairs.join(' | ')}`,
    )
    const overlay = parseOverlay(String(await textAt(sources.overlayPath)))
    assert.equal(overlay.ok, true)
    if (!overlay.ok) return
    assert.deepEqual(overlay.value.version === 2 ? overlay.value.tasks['arena-runners'] : undefined, [
      'arena-runners-1',
      'arena-runners-2',
    ])

    // And it converges: a third load has nothing left to repair.
    assert.deepEqual(viewOf(await handleFleetGet(sources)).repairs, [])
  })
})

test('a rejected groups file is rebuilt rather than overwritten silently, and its error is kept', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)
    await writeFile(sources.groupsPath, '{ this is not json\n')

    const view = viewOf(await handleFleetGet(sources))
    assert.ok(view.groupsError !== null, 'the file error travels to the page')
    assert.match(String(view.groupsError), /not valid JSON/)
    assert.ok(view.repairs.some((line) => line.includes('the groups file was rejected and has been rebuilt')))
    assert.equal(parseFleetGroups(String(await textAt(sources.groupsPath))).ok, true, 'and what is on disk is now usable')
  })
})

test('a fleet the catalog cannot honour is served with its problems and the overlay is left alone', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)
    const good = viewOf(await handleFleetGet(sources))
    const before = String(await textAt(sources.overlayPath))

    // Write a groups file whose general violin points at a route this install does not have.
    const broken = withSelections(good.groups, 'general', [{ provider: 'pi-ai', model: 'pi-1', reasoningEffort: 'high' }])
    await writeFile(sources.groupsPath, serializeFleetGroups(broken))

    const view = viewOf(await handleFleetGet(sources))
    assert.equal(view.problems.length, 1)
    assert.match(String(view.problems[0]), /violin "general" selection 1 \(pi-ai\/pi-1\) is not in the live catalog/)
    assert.ok(
      view.repairs.some((line) => line.includes('did not rewrite') && line.includes('cannot be honoured')),
      'and the page is told the projection was deliberately not written',
    )
    assert.equal(await textAt(sources.overlayPath), before, 'the overlay keeps the last honourable projection')
  })
})

test('GET re-enumerates the catalog when asked, and reports the stock preference as found', async () => {
  await withDir(async (dir) => {
    const refreshes: (boolean | undefined)[] = []
    const sources = sourcesIn(dir, {
      catalog: async (refresh?: boolean) => {
        refreshes.push(refresh)
        return CATALOG
      },
      // Read through `describe()[].value`; the namespace must be named, since that is what the
      // real face reports and what identifies the row.
      settings: { describe: () => [{ ns: 'subagent-model-selection', value: { enabled: true } }] },
    })

    const view = viewOf(await handleFleetGet(sources, true))
    assert.deepEqual(refreshes, [true])
    assert.deepEqual(view.modelSelection, { namespace: 'subagent-model-selection', present: true, enabled: true })
    assert.deepEqual(view.taskKeys, [...ROLE_KEYS])
    assert.deepEqual(view.panelRoles, [...PANEL_ROLES])
    // The defaults place everything, so the unassigned band is empty on a fresh install and every
    // task key resolves through a violin rather than through the resolver's fallback.
    assert.deepEqual(view.unassigned, [], 'nothing is left running on a route nobody chose for it')
    const overlay = parseOverlay(String(await textAt(sources.overlayPath)))
    assert.equal(overlay.ok, true)
    if (overlay.ok && overlay.value.version === 2) {
      assert.deepEqual(Object.keys(overlay.value.tasks).sort(), [...ROLE_KEYS].sort())
      for (const key of PANEL_ROLES) {
        assert.equal(overlay.value.tasks[key]?.length, 2, `${key} fans out over its violin's two selections`)
      }
    }
  })
})

// ---------------------------------------------------------------------------------------------
// The contract that makes the page disposable: a fleet the UI can put on disk is a fleet a
// command-line-only install can use. `tests/client.spec.ts` holds the other half of this pair —
// the body the page PUTs to reach the document read here.
// ---------------------------------------------------------------------------------------------

test('a fleet written through this route is a usable configuration with no UI in the picture', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)
    // One edit chain, of the shape the UI sends: place a task, move another, add a violin.
    const start = viewOf(await handleFleetGet(sources)).groups
    const placed = withTask(start, 'refactoring', 'planning')
    const moved = withTask(placed, 'how-explainer', 'working')
    const body = serializeFleetGroups(moved)
    viewOf(await handleFleetPut(sources, body))

    // 1. The command path resolves the file that landed. This is the whole claim: the spawn tool
    //    reads the overlay through `loadOverlayFile`, exactly as it does without a UI in the loop.
    const loaded = await loadOverlayFile(sources.overlayPath)
    assert.equal(loaded.ok, true)
    if (!loaded.ok || loaded.value === undefined) return

    const refactoring = resolveRole('refactoring', loaded.value, CATALOG)
    assert.equal(refactoring.inherit, false)
    assert.deepEqual(refactoring.route, { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' })
    const explainer = resolveRole('how-explainer', loaded.value, CATALOG)
    assert.deepEqual(explainer.route, { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' })

    // 2. A comparison violin still fans out one child per selection, read from the same file.
    const panel = resolvePanel('arena-runners', loaded.value, CATALOG)
    assert.deepEqual(
      panel.map((entry) => entry.route?.model),
      ['deepseek-v4-pro', 'deepseek-flash'],
    )

    // 3. And every task the build knows answers, so a spawn of any role finds a route rather than a
    //    resolve that falls over a key the file forgot.
    for (const key of ROLE_KEYS) {
      const resolved = resolveRole(key, loaded.value, CATALOG)
      assert.equal(typeof resolved.reason, 'string', `${key} has no resolution at all`)
      assert.ok(
        resolved.inherit || resolved.route !== undefined,
        `${key} resolved to neither a route nor the parent`,
      )
    }
  })
})

// ---------------------------------------------------------------------------------------------
// Write: the gate, the two files, and the refusal that writes nothing.
// ---------------------------------------------------------------------------------------------

test('PUT writes both files, and the answer is the view a GET would give', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)
    const groups = viewOf(await handleFleetGet(sources)).groups
    const withFeature = withTask(groups, 'feature', 'planning')

    const result = await handleFleetPut(sources, serializeFleetGroups(withFeature))
    const view = viewOf(result)

    assert.deepEqual(view.groups, withFeature)
    assert.deepEqual(view.problems, [])
    assert.equal(view.origin, 'file')
    assert.equal(serializeFleetGroups(view.groups), await textAt(sources.groupsPath))

    const overlay = parseOverlay(String(await textAt(sources.overlayPath)))
    assert.equal(overlay.ok, true)
    if (!overlay.ok || overlay.value.version !== 2) return
    assert.deepEqual(overlay.value.tasks['feature'], ['planning'])
    assert.deepEqual(overlay.value.models['planning'], {
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
    })
  })
})

test('a refused PUT writes nothing, not even the file that would have been legal', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)
    const groups = viewOf(await handleFleetGet(sources)).groups
    const before = { groups: await textAt(sources.groupsPath), overlay: await textAt(sources.overlayPath) }

    const withGhost = withSelections(groups, 'general', [{ provider: 'ghost-vendor', model: 'ghost-model' }])
    const refusal = refusalOf(await handleFleetPut(sources, serializeFleetGroups(withGhost)))

    assert.equal(refusal.status, 400)
    assert.match(refusal.error, /the fleet was refused/)
    assert.equal(refusal.problems.length, 1)
    assert.match(String(refusal.problems[0]), /violin "general" selection 1 \(ghost-vendor\/ghost-model\) is not in the live catalog/)
    assert.equal(await textAt(sources.groupsPath), before.groups, 'the groups file is untouched')
    assert.equal(await textAt(sources.overlayPath), before.overlay, 'and so is the overlay')
  })
})

test('PUT refuses an effort the route does not advertise, naming the advertised ones', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)
    const groups = viewOf(await handleFleetGet(sources)).groups
    const invented = withSelections(groups, 'working', [
      { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'xhigh' },
    ])

    const refusal = refusalOf(await handleFleetPut(sources, serializeFleetGroups(invented)))
    assert.equal(refusal.status, 400)
    assert.match(String(refusal.problems[0]), /asks for reasoningEffort "xhigh" but the route advertises off, low, high, max/)
  })
})

test('PUT refuses a comparison violin left holding a task that names only one model', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)
    const groups = viewOf(await handleFleetGet(sources)).groups
    const doubled = withSelections(withTask(groups, 'feature', 'planning'), 'planning', [
      { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' },
      { provider: 'deepseek-official', model: 'deepseek-v4-flash', reasoningEffort: 'low' },
    ])

    const refusal = refusalOf(await handleFleetPut(sources, serializeFleetGroups(doubled)))
    assert.equal(refusal.status, 400)
    assert.match(String(refusal.problems[0]), /violin "planning" has 2 model selections and holds /)
    assert.match(String(refusal.problems[0]), /"feature"/)
  })
})

test('PUT refuses a body that is not a fleet document, a secret-shaped field, and an oversized body', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)

    const notJson = refusalOf(await handleFleetPut(sources, 'nonsense'))
    assert.equal(notJson.status, 400)
    assert.match(notJson.error, /not valid JSON/)

    const secret = refusalOf(
      await handleFleetPut(
        sources,
        JSON.stringify({
          version: 1,
          violins: PREDEFINED_VIOLIN_IDS.map((id) => ({
            id,
            name: id,
            origin: 'predefined',
            selections: [{ provider: 'deepseek-official', model: 'deepseek-flash', apiKey: 'sk-secret' }],
            tasks: [],
          })),
        }),
      ),
    )
    assert.equal(secret.status, 400)
    assert.match(secret.error, /unknown key "apiKey"/)

    const huge = refusalOf(await handleFleetPut(sources, '{"version":1}', true))
    assert.equal(huge.status, 413)
    assert.match(huge.error, new RegExp(String(MAX_FLEET_BODY_BYTES)))
    assert.deepEqual(await readdir(dir), [], 'none of the three touched the filesystem')
  })
})

test('PUT answers 500 and keeps the previous fleet when a file cannot be written', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)
    const groups = viewOf(await handleFleetGet(sources)).groups
    // A directory where the overlay file must go: the atomic rename cannot succeed.
    await rm(sources.overlayPath, { force: true })
    await mkdir(sources.overlayPath)

    const warnings: string[] = []
    const failing = sourcesIn(dir, { logger: { warn: (message) => warnings.push(message) } })
    const result = await handleFleetPut(failing, serializeFleetGroups(withTask(groups, 'feature', 'planning')))

    assert.equal(result.status, 500)
    assert.match(String((result.body as { error: string }).error), /the fleet could not be written/)
    assert.equal(warnings.length, 1)
    assert.ok(await textAt(sources.groupsPath), 'the groups file it managed to write is still there')
  })
})

test('the route checks req.method itself and reports the writes it will not take', async () => {
  await withDir(async (dir) => {
    const route = createFleetRoute(sourcesIn(dir))
    assert.equal(route.kind, 'exact')
    assert.equal(route.path, FLEET_ROUTE_PATH)

    const get = await call(route, fakeRequest('GET', `${FLEET_ROUTE_PATH}?refresh=1`))
    assert.equal(get.status, 200)
    assert.equal(get.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(get.headers['cache-control'], 'no-store')

    const groups = (get.body as unknown as FleetView).groups
    const put = await call(route, fakeRequest('PUT', FLEET_ROUTE_PATH, serializeFleetGroups(groups)))
    assert.equal(put.status, 200)
    assert.equal((put.body as { origin?: string }).origin, 'file')

    const post = await call(route, fakeRequest('POST', FLEET_ROUTE_PATH, '{}'))
    assert.equal(post.status, 405)
    assert.equal(post.headers['allow'], 'GET, PUT')
    assert.match(String(post.body['error']), /POST is not supported/)
  })
})

test('the groups file is written `0o600`, like every other document under DSH_HOME', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)
    viewOf(await handleFleetGet(sources))
    const { stat } = await import('node:fs/promises')
    const info = await stat(sources.groupsPath)
    assert.equal(info.mode & 0o777, GROUPS_FILE_MODE)
  })
})

test('a fleet with no route at all still writes: every task says inherit, and nothing is invented', async () => {
  await withDir(async (dir) => {
    const empty: RouteCatalog = { routes: [], unavailable: [] }
    const sources = sourcesIn(dir, { catalog: async () => empty, sessionDefault: () => SESSION_DEFAULT })

    const view = viewOf(await handleFleetGet(sources))
    assert.deepEqual(view.problems, [], 'an empty catalog is not a refused fleet; it is an empty one')
    for (const id of PREDEFINED_VIOLIN_IDS) {
      assert.deepEqual(view.groups.violins.find((v) => v.id === id)?.selections, [], `${id} has nothing to offer`)
    }
    const overlay = parseOverlay(String(await textAt(sources.overlayPath)))
    assert.equal(overlay.ok, true)
    if (!overlay.ok || overlay.value.version !== 2) return
    assert.deepEqual(overlay.value.tasks['feature'], ['inherit-parent'])
    assert.deepEqual(Object.keys(overlay.value.models), [])
  })
})

test('a groups document missing a predefined violin is refused, and the message says so', async () => {
  await withDir(async (dir) => {
    const sources = sourcesIn(dir)
    const groups: FleetGroupsFile = viewOf(await handleFleetGet(sources)).groups
    const incomplete = { version: 1 as const, violins: groups.violins.filter((violin) => violin.id !== 'vision') }

    const refusal = refusalOf(await handleFleetPut(sources, serializeFleetGroups(incomplete)))
    assert.equal(refusal.status, 400)
    assert.match(refusal.error, /the predefined violin "vision" is missing/)
  })
})
