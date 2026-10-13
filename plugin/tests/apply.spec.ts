/**
 * `apply()` wiring: what the Host actually gets when it loads this plugin.
 *
 * This is the strongest check that runs without a Host. It calls the real `apply()` with a
 * recording stand-in for `ctx.skills` / `ctx.tools`, and asserts the two registrations, the
 * factory's return value, and the marker line. It cannot prove Cordis calls `apply()` at all —
 * that is ACCEPTANCE 4 and needs a booted Host; see the report.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply, BOOT_MARKER, defaultSkillsDir, inject, name, serializeOverlay } from '../src/index.ts'
import { PSTACK_SKILL_PROVIDER } from '../src/skills/provider.ts'
import type { SkillProvider, SkillProviderControl } from '../src/skills/provider.ts'
import { PSTACK_STATUS_TOOL, describePstackStatus } from '../src/tools/status.ts'
import type { ToolDefinitionLike } from '../src/tools/status.ts'
import { PSTACK_SPAWN_TOOL } from '../src/tools/spawn.ts'
import { PSTACK_SPAWN_PANEL_TOOL } from '../src/tools/spawn-panel.ts'
import type { SpawnRunContext } from '../src/tools/spawn.ts'
import { EFFORT_WATERFALL_EVENT } from '../src/effort.ts'
import type { AgentRequestListener } from '../src/effort.ts'

interface Recording {
  readonly ctx: Parameters<typeof apply>[0]
  readonly providers: SkillProvider[]
  readonly tools: ToolDefinitionLike[]
  readonly lines: string[]
  readonly warnings: string[]
  readonly listeners: { event: string; listener: AgentRequestListener }[]
}

/** A context that records what `apply` registers, with a live registration signal. */
function recorder(): Recording {
  const providers: SkillProvider[] = []
  const tools: ToolDefinitionLike[] = []
  const lines: string[] = []
  const warnings: string[] = []
  const listeners: { event: string; listener: AgentRequestListener }[] = []
  return {
    providers,
    tools,
    lines,
    warnings,
    listeners,
    ctx: {
      logger: { info: (message) => lines.push(message), warn: (message) => warnings.push(message) },
      skills: {
        registerProvider: (create: (control: SkillProviderControl) => SkillProvider) => {
          providers.push(create({ signal: new AbortController().signal, invalidate: () => {} }))
          return () => {}
        },
      },
      tools: { register: (definition) => void tools.push(definition) },
      // The spawn tool's only side effect. Never called by these tests.
      subagents: { start: async () => ({}) },
      // Route enumeration is lazy: `apply()` builds the resolver but reads nothing from these
      // until a spawn resolves a role, so empty fakes are the honest stand-in here.
      llm: {
        listProviders: () => [],
        listModels: async () => [],
        resolveModelInfo: async () => ({ reasoning: { efforts: [] } }),
      },
      // `settings` is optional on the context: it seeds the `general` violin from the session's
      // default model, and its absence falls back to the catalog's first route rather than failing.
      settings: { describe: () => [] },
      on: (event, listener) => {
        listeners.push({ event, listener })
        return () => {}
      },
    },
  }
}

test('apply() registers exactly one skill provider, named pstack', () => {
  const recording = recorder()
  apply(recording.ctx, { overlayPath: '/nonexistent/pstack.json', skillsDir: defaultSkillsDir() })

  assert.equal(recording.providers.length, 1)
  assert.equal(recording.providers[0]?.name, PSTACK_SKILL_PROVIDER)
})

test('the registered provider finds the bundled skill through the real tree', async () => {
  const recording = recorder()
  apply(recording.ctx, { overlayPath: '/nonexistent/pstack.json' })

  const provider = recording.providers[0]
  assert.ok(provider)
  const candidates = await provider.list({})
  // Containment, not equality: Phase 3 adds the other 46 skills to this same directory.
  assert.ok(
    candidates.some((candidate) => candidate.name === 'pstack-self-check'),
    `bundled skills were: ${candidates.map((candidate) => candidate.name).join(', ') || '(none)'}`,
  )
})

test('apply() registers all three tools, and each answers when called', async () => {
  const recording = recorder()
  apply(recording.ctx, { overlayPath: '/nonexistent/pstack.json' })

  assert.deepEqual(
    recording.tools.map((tool) => tool.name).sort(),
    [PSTACK_SPAWN_TOOL, PSTACK_SPAWN_PANEL_TOOL, PSTACK_STATUS_TOOL].sort(),
  )
  const status = recording.tools.find((tool) => tool.name === PSTACK_STATUS_TOOL)
  assert.ok(status)

  const value = (await status.execute({}, {})) as { plugin: string; bootMarker: string }
  assert.equal(value.plugin, 'pstack')
  assert.equal(value.bootMarker, BOOT_MARKER)
})

test('apply() subscribes the effort listener to the agent/request waterfall', () => {
  const recording = recorder()
  apply(recording.ctx, { overlayPath: '/nonexistent/pstack.json' })
  assert.equal(recording.listeners.length, 1)
  assert.equal(recording.listeners[0]?.event, EFFORT_WATERFALL_EVENT)
  assert.equal(typeof recording.listeners[0]?.listener, 'function')
})

test('registerSkills: false skips the provider but keeps all three tools', () => {
  const recording = recorder()
  apply(recording.ctx, { registerSkills: false, overlayPath: '/nonexistent/pstack.json' })

  assert.equal(recording.providers.length, 0)
  assert.equal(recording.tools.length, 3)
  assert.match(recording.lines[0] ?? '', /skillProvider=none/)
})

test('the marker line names what was registered, so a Host log is evidence', () => {
  const recording = recorder()
  apply(recording.ctx, { overlayPath: '/tmp/overlay.json', skillsDir: '/tmp/skills' })

  assert.equal(recording.lines.length, 1)
  const line = recording.lines[0] ?? ''
  assert.ok(line.startsWith(BOOT_MARKER), line)
  assert.match(line, /skillProvider=pstack/)
  assert.match(line, /tool=pstack_status/)
  assert.match(line, /spawn=pstack_spawn/)
  assert.match(line, /spawnProvider=spawn/)
  assert.match(line, /effortListener=agent\/request/)
  assert.match(line, /skillsDir=\/tmp\/skills/)
  assert.match(line, /overlay=\/tmp\/overlay\.json/)
})

test('apply() never silently skips registration when a service is present', () => {
  // Every registry is a required injection, so Cordis holds this plugin inactive until they all
  // exist (`cordis/lib/index.js:1634`); there is no path where apply() runs and registers nothing.
  const recording = recorder()
  apply(recording.ctx, {})
  assert.equal(recording.providers.length + recording.tools.length + recording.listeners.length, 5)
})

test('inject declares exactly the services this plugin registers on', () => {
  // Cordis reads this array off the plugin module; without it `apply` could run before a registry
  // is provided and register into nothing. The list is asserted **exactly**, not by containment:
  // a service added to `apply()` but forgotten here means the plugin is held inactive and says
  // nothing (plugin/HARNESS.md §Rules 8), and a name added here with no user means a plugin that
  // never activates at all. Both mistakes are caught by an exact comparison and neither by a
  // "contains" check.
  // `credentials` and `settings` left this list on 2026-10-13, with the credential gate they existed
  // for. Every name here is a service Cordis waits for, so dropping them is not tidiness: it is two
  // fewer ways for the plugin to be held inactive by a composition that does not provide them.
  assert.deepEqual([...inject].sort(), ['llm', 'skills', 'subagents', 'tools'])
})

test('the wired spawn tool runs a mapped role end to end: hand-edited overlay + live-shaped catalog', async () => {
  // This is the wiring, not the unit: `apply()` builds the resolver through `createRoleResolver`
  // and hands it to the tool it registers, so a role written into a real overlay file and a route
  // the llm service really reports must come out as `agentOptions` on the captured request.
  const dir = await mkdtemp(join(tmpdir(), 'pstack-apply-'))
  try {
    const overlayPath = join(dir, 'pstack.json')
    await writeFile(
      overlayPath,
      serializeOverlay({
        version: 2,
        models: { main: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' } },
        tasks: { architect: ['main'] },
      }),
      'utf8',
    )

    const recording = recorder()
    const started: Record<string, unknown>[] = []
    recording.ctx.llm.listProviders = () => [{ id: 'deepseek-official', name: 'DeepSeek' }]
    recording.ctx.llm.listModels = async () => [
      { provider: 'deepseek-official', id: 'deepseek-flash', name: 'DeepSeek Flash' },
    ]
    recording.ctx.llm.resolveModelInfo = async () => ({
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'high', name: 'High' },
        ],
        defaultEffort: 'high',
      },
    })
    // No settings or credentials stub: the catalog no longer consults either. A route is honoured
    // because the adapter registered the model, which is the fact this wiring test is about.
    recording.ctx.subagents.start = async (_name: string, request: unknown) => {
      started.push(request as Record<string, unknown>)
      return {
        id: 'child-1',
        result: Promise.resolve({ stopReason: 'completed', output: [{ type: 'text', text: 'PONG' }] }),
        dispose: async () => {},
      }
    }

    apply(recording.ctx, { overlayPath })
    const spawn = recording.tools.find((tool) => tool.name === PSTACK_SPAWN_TOOL)
    assert.ok(spawn, 'apply() did not register pstack_spawn')

    const exec: SpawnRunContext = { agent: { id: 'parent' } }
    const value = (await spawn.execute({ role: 'architect', prompt: 'Design the seam.' }, exec)) as Record<string, unknown>

    assert.equal(started.length, 1)
    assert.deepEqual(started[0]?.['agentOptions'], {
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      reasoningEffort: 'high',
    })
    assert.equal(value['inherited'], false)
    assert.equal(value['routeProvider'], 'deepseek-official')
    assert.equal(value['routeModel'], 'deepseek-flash')
    assert.equal(value['output'], 'PONG')

    // And the inheriting case through the same wiring: a role the overlay never mentions.
    await spawn.execute({ role: 'tdd', prompt: 'go' }, exec)
    assert.equal(Object.hasOwn(started[1] ?? {}, 'agentOptions'), false)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plugin name stays kebab-case and dependency-free', () => {
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
})

test('defaultSkillsDir points at the package skills tree from either src or lib', async () => {
  const dir = defaultSkillsDir()
  assert.match(dir, /\/skills\/?$/)
  const value = await describePstackStatus({
    bootMarker: BOOT_MARKER,
    overlayPath: '/nonexistent/pstack.json',
    skillsDir: dir,
    pluginName: name,
  })
  // Containment, not equality: Phase 3 grows this directory.
  assert.ok(value.skillNames.includes('pstack-self-check'), `skillNames: ${value.skillNames.join(', ')}`)
})
