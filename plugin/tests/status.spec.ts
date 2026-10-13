/**
 * The `pstack_status` value and definition shape.
 *
 * Registration-time validation belongs to the registry (`dsh-tools/lib/index.js:2773` checks
 * `output { schema, render }`, then `assertSupportedJsonSchema` :322). This file asserts the
 * properties that validator enforces — a JSON-Schema `required` array naming only declared
 * properties, boolean `additionalProperties` on every object — plus the value's behaviour on a
 * missing, valid, and broken overlay, and on the fleet groups file reported beside it. The real
 * registration check is the booted Host.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BOOT_MARKER } from '../src/index.ts'
import { isPredefinedViolinId, PREDEFINED_VIOLIN_IDS } from '../src/roles/fleet-groups.ts'
import { PANEL_ROLES } from '../src/roles/overlay.ts'
import { createPstackStatusTool, describePstackStatus, PSTACK_STATUS_TOOL } from '../src/tools/status.ts'

/** Build a temp dir, run `body`, always clean up. */
async function withTemp<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'pstack-status-'))
  try {
    return await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Walk a raw schema and collect every object node, for the shape assertions below. */
function objectNodes(schema: unknown): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = []
  const visit = (node: unknown): void => {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return
    const record = node as Record<string, unknown>
    if (record['type'] === 'object') found.push(record)
    const properties = record['properties']
    if (typeof properties === 'object' && properties !== null) {
      for (const child of Object.values(properties as Record<string, unknown>)) visit(child)
    }
    visit(record['items'])
    for (const arm of Array.isArray(record['oneOf']) ? record['oneOf'] : []) visit(arm)
  }
  visit(schema)
  return found
}

/**
 * A groups file the parser accepts, with `ids` in the given order.
 *
 * Built from the exported id lists rather than literals, so this fixture cannot name a violin the
 * build does not have — the parser refuses a file that is missing any of them.
 */
function groupsFileText(ids: readonly string[]): string {
  return JSON.stringify({
    version: 1,
    violins: ids.map((id) => ({
      id,
      name: id,
      origin: isPredefinedViolinId(id) ? 'predefined' : 'comparison',
      selections: [],
      tasks: [],
    })),
  })
}

test('the definition is shaped the way the registry validates', () => {
  const tool = createPstackStatusTool({
    bootMarker: BOOT_MARKER,
    overlayPath: '/nonexistent/pstack.json',
    groupsPath: '/nonexistent/pstack-fleet.json',
    skillsDir: '/nonexistent',
    pluginName: 'pstack',
  })
  assert.equal(tool.name, PSTACK_STATUS_TOOL)
  assert.match(tool.name, /^[a-z0-9]+(?:_[a-z0-9]+)*$/)
  assert.ok(tool.description.length > 40)
  assert.deepEqual(tool.parameters, { type: 'object', properties: {} })

  const schema = tool.output.schema as Record<string, unknown>
  assert.equal(typeof tool.output.render, 'function')
  assert.equal(schema['type'], 'object')
  const objects = objectNodes(schema)
  assert.ok(objects.length > 0)
  for (const node of objects) {
    assert.equal(typeof node['additionalProperties'], 'boolean', 'explicit objects declare additionalProperties')
    const required = node['required']
    if (required === undefined) continue
    // checkObjectSchemaTail (dsh-tools/lib/index.js:151): required is an array of strings that
    // must name declared properties. defineTool's per-property `required: true` is author-side
    // sugar compiled away before registration, so it must not appear here.
    assert.ok(Array.isArray(required))
    const properties = (node['properties'] ?? {}) as Record<string, unknown>
    for (const key of required as unknown[]) {
      assert.equal(typeof key, 'string')
      assert.ok(Object.hasOwn(properties, key as string), `required names undeclared property ${String(key)}`)
    }
    for (const property of Object.values(properties)) {
      assert.ok(!Object.hasOwn(property as object, 'required'), 'no per-property required in a raw schema')
    }
  }

  // A model reads this schema, so the fields the report always has are declared with their type and
  // named as required — the groups file is reported beside the overlay, in the same breath.
  const properties = schema['properties'] as Record<string, Record<string, unknown>>
  const required = schema['required'] as string[]
  const declared: readonly (readonly [string, string])[] = [
    ['groupsPath', 'string'],
    ['groupsViolins', 'array'],
  ]
  for (const [key, type] of declared) {
    assert.equal(properties[key]?.['type'], type, `${key} is declared with its type`)
    assert.ok(required.includes(key), `required names ${key}`)
  }
})

test('render() returns one text block holding the canonical value', async () => {
  const tool = createPstackStatusTool({
    bootMarker: BOOT_MARKER,
    overlayPath: '/nonexistent/pstack.json',
    groupsPath: '/nonexistent/pstack-fleet.json',
    skillsDir: '/nonexistent',
    pluginName: 'pstack',
  })
  const value = await tool.execute({}, {})
  const blocks = tool.output.render({}, value)
  assert.equal(blocks.length, 1)
  assert.equal(blocks[0]?.type, 'text')
  assert.deepEqual(JSON.parse(blocks[0]?.text ?? '{}'), value)
})

test('a missing overlay is reported, not thrown', async () => {
  await withTemp(async (dir) => {
    const overlayPath = join(dir, 'pstack.json')
    const value = await describePstackStatus({
      bootMarker: BOOT_MARKER,
      overlayPath,
      groupsPath: join(dir, 'pstack-fleet.json'),
      skillsDir: join(dir, 'skills'),
      pluginName: 'pstack',
    })
    assert.equal(value.overlayPresent, false)
    assert.deepEqual(value.overlayRoles, [])
    assert.deepEqual(value.skillNames, [])
    assert.equal(value.overlayPath, overlayPath)
  })
})

test('a valid overlay reports its top-level keys', async () => {
  await withTemp(async (dir) => {
    const overlayPath = join(dir, 'pstack.json')
    await writeFile(overlayPath, JSON.stringify({ architect: { model: 'x' }, tdd: {} }), 'utf8')
    const value = await describePstackStatus({
      bootMarker: BOOT_MARKER,
      overlayPath,
      groupsPath: join(dir, 'pstack-fleet.json'),
      skillsDir: join(dir, 'skills'),
      pluginName: 'pstack',
    })
    assert.equal(value.overlayPresent, true)
    assert.deepEqual(value.overlayRoles, ['architect', 'tdd'])
    assert.ok(value.notes.some((note) => note.includes('top-level keys only')))
  })
})

test('a broken overlay is a note, never a crash', async () => {
  await withTemp(async (dir) => {
    const overlayPath = join(dir, 'pstack.json')
    await writeFile(overlayPath, '{ not json', 'utf8')
    const value = await describePstackStatus({
      bootMarker: BOOT_MARKER,
      overlayPath,
      groupsPath: join(dir, 'pstack-fleet.json'),
      skillsDir: join(dir, 'skills'),
      pluginName: 'pstack',
    })
    assert.equal(value.overlayPresent, true)
    assert.deepEqual(value.overlayRoles, [])
    assert.ok(value.notes.some((note) => note.includes('not valid JSON')))
  })
})

test('a missing groups file is reported without a note of its own', async () => {
  await withTemp(async (dir) => {
    const groupsPath = join(dir, 'pstack-fleet.json')
    const value = await describePstackStatus({
      bootMarker: BOOT_MARKER,
      overlayPath: join(dir, 'pstack.json'),
      groupsPath,
      skillsDir: join(dir, 'skills'),
      pluginName: 'pstack',
    })
    assert.equal(value.groupsPath, groupsPath)
    assert.deepEqual(value.groupsViolins, [])
    // No overlay either, so this is a fresh install — a state, not something to flag.
    assert.equal(value.overlayPresent, false)
    assert.equal(value.notes.some((note) => note.includes('fleet groups')), false)
  })
})

test('a present groups file reports its violin ids in file order', async () => {
  await withTemp(async (dir) => {
    const groupsPath = join(dir, 'pstack-fleet.json')
    // Deliberately not the page's order (predefined first, then one violin per comparison task):
    // the report is a read of the file, so a caller must see the file's order, not a canonical one.
    const ids: string[] = [...PREDEFINED_VIOLIN_IDS, ...PANEL_ROLES].reverse()
    await writeFile(groupsPath, groupsFileText(ids), 'utf8')
    const value = await describePstackStatus({
      bootMarker: BOOT_MARKER,
      overlayPath: join(dir, 'pstack.json'),
      groupsPath,
      skillsDir: join(dir, 'skills'),
      pluginName: 'pstack',
    })
    assert.equal(value.groupsPath, groupsPath)
    assert.deepEqual(value.groupsViolins, ids)
    assert.equal(value.notes.some((note) => note.includes('fleet groups')), false)
  })
})

test('a groups file that is not JSON is a note naming the reason, never a crash', async () => {
  await withTemp(async (dir) => {
    const groupsPath = join(dir, 'pstack-fleet.json')
    await writeFile(groupsPath, '{ not json', 'utf8')
    const value = await describePstackStatus({
      bootMarker: BOOT_MARKER,
      overlayPath: join(dir, 'pstack.json'),
      groupsPath,
      skillsDir: join(dir, 'skills'),
      pluginName: 'pstack',
    })
    assert.deepEqual(value.groupsViolins, [])
    assert.ok(value.notes.some((note) => note.includes('not valid JSON')), `notes: ${value.notes.join('; ')}`)
  })
})

test('a groups path that is not a readable file is present with a note, never a crash', async () => {
  await withTemp(async (dir) => {
    // A directory where the file belongs: reading it fails, which must not read as "no file at all".
    const groupsPath = join(dir, 'pstack-fleet.json')
    await mkdir(groupsPath)
    const value = await describePstackStatus({
      bootMarker: BOOT_MARKER,
      overlayPath: join(dir, 'pstack.json'),
      groupsPath,
      skillsDir: join(dir, 'skills'),
      pluginName: 'pstack',
    })
    assert.deepEqual(value.groupsViolins, [])
    assert.ok(value.notes.some((note) => note.startsWith('fleet groups file')), `notes: ${value.notes.join('; ')}`)
  })
})

test('valid JSON the violin page would refuse is reported, not read as an empty fleet', async () => {
  await withTemp(async (dir) => {
    const groupsPath = join(dir, 'pstack-fleet.json')
    await writeFile(groupsPath, JSON.stringify({ version: 2, violins: [] }), 'utf8')
    const value = await describePstackStatus({
      bootMarker: BOOT_MARKER,
      overlayPath: join(dir, 'pstack.json'),
      groupsPath,
      skillsDir: join(dir, 'skills'),
      pluginName: 'pstack',
    })
    assert.deepEqual(value.groupsViolins, [])
    assert.ok(value.notes.some((note) => note.includes('version must be 1')), `notes: ${value.notes.join('; ')}`)
  })
})

test('an absent groups file beside an existing overlay says the overlay is the whole truth', async () => {
  await withTemp(async (dir) => {
    const overlayPath = join(dir, 'pstack.json')
    await writeFile(overlayPath, JSON.stringify({ architect: { model: 'x' } }), 'utf8')
    const value = await describePstackStatus({
      bootMarker: BOOT_MARKER,
      overlayPath,
      groupsPath: join(dir, 'pstack-fleet.json'),
      skillsDir: join(dir, 'skills'),
      pluginName: 'pstack',
    })
    assert.equal(value.overlayPresent, true)
    assert.deepEqual(value.groupsViolins, [])
    const note = value.notes.find((entry) => entry.includes('fleet groups file is absent'))
    assert.ok(note !== undefined, `notes: ${value.notes.join('; ')}`)
    assert.match(note, /violin page writes the groups file on its first load/)
  })
})

test('a caller that configured no groups path claims nothing about a file', async () => {
  await withTemp(async (dir) => {
    const overlayPath = join(dir, 'pstack.json')
    await writeFile(overlayPath, JSON.stringify({ architect: { model: 'x' } }), 'utf8')
    const value = await describePstackStatus({
      bootMarker: BOOT_MARKER,
      overlayPath,
      skillsDir: join(dir, 'skills'),
      pluginName: 'pstack',
    })
    assert.equal(value.groupsPath, '')
    assert.deepEqual(value.groupsViolins, [])
    // An overlay with no groups path to look at is not the "absent beside an overlay" state: the tool
    // cannot report a file missing when the caller never named one.
    assert.equal(value.notes.some((note) => note.includes('fleet groups')), false)
  })
})

test('a cancelled call stops before reporting a partial picture', async () => {
  await assert.rejects(
    () =>
      describePstackStatus(
        { bootMarker: BOOT_MARKER, overlayPath: '/x', skillsDir: '/y', pluginName: 'pstack' },
        { signal: AbortSignal.abort() },
      ),
    /abort/i,
  )
})
