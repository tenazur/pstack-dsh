/**
 * Phase 2 gate: the plugin's contract is checkable without a running Host.
 *
 * These are rung 4 checks — they call the real code and fail loud. They do NOT prove
 * the plugin boots in DSH; that is the Phase 2 gate and needs a live Host.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BOOT_MARKER, defaultGroupsPath, defaultOverlayPath, name } from '../src/index.ts'

test('plugin name is kebab-case, as DSH requires', () => {
  assert.match(name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/)
})

test('boot marker is a stable literal a check can grep for', () => {
  assert.equal(BOOT_MARKER, '[dsh-pstack] loaded')
})

test('defaultOverlayPath honours DSH_HOME', () => {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/fake-dsh-home'
  try {
    assert.equal(defaultOverlayPath(), '/tmp/fake-dsh-home/pstack.json')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('defaultGroupsPath is the groups file beside the overlay, and honours DSH_HOME', () => {
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = '/tmp/fake-dsh-home'
  try {
    assert.equal(defaultGroupsPath(), '/tmp/fake-dsh-home/pstack-fleet.json')
    assert.notEqual(defaultGroupsPath(), defaultOverlayPath(), 'two files, or the projection would overwrite its source')
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
})

test('defaultOverlayPath falls back to ~/.dsh', () => {
  const prev = process.env.DSH_HOME
  delete process.env.DSH_HOME
  try {
    assert.equal(defaultOverlayPath(), `${process.env.HOME}/.dsh/pstack.json`)
  } finally {
    if (prev !== undefined) process.env.DSH_HOME = prev
  }
})
