import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  modelWindow,
  calculateContextWindow,
  calculateSubagentContext,
} from '../scripts/lib/context.mjs'

const row = (model, context, extra = {}) => ({
  type: 'assistant',
  message: { model, usage: { input_tokens: context } },
  ...extra,
})

test('modelWindow reads listed IDs, date suffixes, and provider prefixes', () => {
  assert.equal(modelWindow('claude-opus-5-5'), 1_000_000)
  assert.equal(modelWindow('claude-opus-5'), 1_000_000)
  assert.equal(modelWindow('claude-sonnet-5'), 1_000_000)
  assert.equal(modelWindow('claude-haiku-4-5-20251001'), 200_000)
  assert.equal(modelWindow('us.anthropic.claude-opus-4-8'), 1_000_000)
  // A date directly after the major version is not a minor version.
  assert.equal(modelWindow('claude-opus-5-20260101'), 1_000_000)
})

test('modelWindow returns null for unlisted or malformed IDs', () => {
  assert.equal(modelWindow('claude-sonnet-4-5'), null)
  assert.equal(modelWindow('<synthetic>'), null)
  assert.equal(modelWindow(null), null)
})

test('a listed model sets the window with basis model', () => {
  const cw = calculateContextWindow([row('claude-haiku-4-5-20251001', 150_000)])
  assert.equal(cw.size, 200_000)
  assert.equal(cw.windowBasis, 'model')
  assert.equal(cw.usedPercentage, 75)
  assert.equal(cw.compactThreshold, 167_000)
  assert.equal(cw.headroom, 17_000)
})

test('a /model switch measures the current reading against the new model', () => {
  const cw = calculateContextWindow([
    row('claude-opus-5-5', 400_000),
    row('claude-haiku-4-5-20251001', 150_000),
  ])
  assert.equal(cw.model, 'claude-haiku-4-5-20251001')
  assert.equal(cw.size, 200_000)
  assert.equal(cw.usedPercentage, 75)
  assert.equal(cw.peak, 400_000)
  assert.equal(cw.peakModel, 'claude-opus-5-5')
  assert.equal(cw.peakPercentage, 40)
})

test('an unlisted model past 200k resolves to 1M as observed', () => {
  const cw = calculateContextWindow([row('claude-nova-9', 300_000), row('claude-nova-9', 100_000)])
  assert.equal(cw.size, 1_000_000)
  assert.equal(cw.windowBasis, 'observed')
  assert.equal(cw.usedPercentage, 10)
})

test('an unlisted model under 200k reports exact tokens and no percentage', () => {
  const cw = calculateContextWindow([row('claude-nova-9', 150_000)])
  assert.equal(cw.used, 150_000)
  assert.equal(cw.size, null)
  assert.equal(cw.windowBasis, 'unknown')
  assert.equal(cw.usedPercentage, null)
  assert.equal(cw.headroom, null)
})

test('a peak on one unlisted model never sets the window of another', () => {
  const cw = calculateContextWindow([row('claude-nova-9', 300_000), row('claude-lyra-1', 100_000)])
  assert.equal(cw.windowBasis, 'unknown')
  assert.equal(cw.size, null)
})

test('zero-occupancy rows and sidechain rows are skipped', () => {
  const cw = calculateContextWindow([
    row('claude-opus-5-5', 100_000),
    row('claude-opus-5-5', 0),
    row('claude-opus-5-5', 500_000, { isSidechain: true }),
  ])
  assert.equal(cw.used, 100_000)
  assert.equal(cw.peak, 100_000)
})

test('subagents report size and percentage from their own model', () => {
  const [agent] = calculateSubagentContext(
    [row('claude-haiku-4-5-20251001', 50_000, { subagent: 'agent-a' })],
    () => 'Explore'
  )
  assert.deepEqual(agent, {
    agentId: 'agent-a',
    peak: 50_000,
    size: 200_000,
    peakPercentage: 25,
    models: ['claude-haiku-4-5-20251001'],
    name: 'Explore',
  })
})
