import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeParams, strategyIdOf, strategyLabel } from '../src/shared/strategy'

test('token strategy IDs include encoding and token units', () => {
  const params = {
    kind: 'fixed-token',
    size: 1024,
    overlap: 128,
    encoding: 'cl100k_base'
  } as const

  assert.equal(strategyIdOf(params), 'fixed-token-cl100k_base-1024-128')
  assert.equal(strategyLabel(params), 'Fixed tokens 1024/128')
})

test('normalizes early token configs that omitted the encoding', () => {
  assert.deepEqual(normalizeParams({ kind: 'fixed-token', size: 512, overlap: 64 }), {
    kind: 'fixed-token',
    size: 512,
    overlap: 64,
    encoding: 'cl100k_base'
  })
})

test('keeps legacy fixed character strategy IDs stable', () => {
  const params = { kind: 'fixed', size: 1200, overlap: 200 } as const
  assert.equal(strategyIdOf(params), 'fixed-1200-200')
  assert.match(strategyLabel(params), /legacy/)
})

test('structural token strategy IDs distinguish the target and hard maximum', () => {
  const params = {
    kind: 'structural-token',
    targetSize: 1024,
    maxSize: 1280,
    encoding: 'cl100k_base'
  } as const
  assert.equal(
    strategyIdOf(params),
    'structural-token-cl100k_base-1024-1280'
  )
  assert.match(strategyLabel(params), /tokens.*1024.*1280/)
})
