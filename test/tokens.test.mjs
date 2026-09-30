import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  calculateDedupedOutput,
  calculateOutputBySpeed,
  calculateThinkingOutput,
} from '../scripts/lib/tokens.mjs'
import { contextOccupancy } from '../scripts/lib/context.mjs'
import { streamlineMessage } from '../scripts/lib/messages.mjs'

const row = (requestId, usage, extra = {}) => ({
  type: 'assistant',
  requestId,
  message: { role: 'assistant', model: 'claude-opus-5-5', content: [], usage },
  ...extra,
})

const usage = (output, thinking, more = {}) => ({
  input_tokens: 2,
  output_tokens: output,
  ...(thinking === undefined ? {} : { output_tokens_details: { thinking_tokens: thinking } }),
  ...more,
})

test('thinking is exact when every request reports it, from the closing line', () => {
  const rows = [
    row('r1', usage(1, 0)),
    row('r1', usage(300, 120)), // closing line: largest output_tokens
    row('r2', usage(50, 10)),
  ]
  assert.deepEqual(calculateThinkingOutput(rows), { thinking: 130, exact: true })
})

test('thinking is not exact when one request lacks the field', () => {
  const rows = [row('r1', usage(300, 120)), row('r2', usage(50), { subagent: 'agent-a' })]
  assert.deepEqual(calculateThinkingOutput(rows), { thinking: 120, exact: false })
  assert.deepEqual(calculateThinkingOutput([]), { thinking: 0, exact: false })
})

test('thinking reads the streamlined field too', () => {
  const rows = [streamlineMessage({ ...row('r1', usage(300, 120)), uuid: 'u1' })]
  assert.equal(rows[0].message.usage.thinking, 120)
  assert.deepEqual(calculateThinkingOutput(rows), { thinking: 120, exact: true })
})

test('output splits by speed, one final usage per request', () => {
  const rows = [
    row('r1', usage(1, 0, { speed: 'standard' })),
    row('r1', usage(300, 0, { speed: 'standard' })),
    row('r2', usage(40, 0, { speed: 'fast' })),
    row('r3', usage(9)),
  ]
  assert.deepEqual(calculateOutputBySpeed(rows), { standard: 300, fast: 40 })
  assert.deepEqual(calculateOutputBySpeed([row('r3', usage(9))]), {})
})

test('synthetic API-error rows carry no requestId and count for nothing', () => {
  const synthetic = {
    type: 'assistant',
    isApiErrorMessage: true,
    message: {
      role: 'assistant',
      model: '<synthetic>',
      content: [],
      usage: { input_tokens: 0, output_tokens: 0, output_tokens_details: null, iterations: null, speed: null },
    },
  }
  const rows = [row('r1', usage(300, 120)), synthetic]
  assert.equal(calculateDedupedOutput(rows), 300)
  assert.deepEqual(calculateThinkingOutput(rows), { thinking: 120, exact: true })
  assert.deepEqual(calculateOutputBySpeed(rows), {})
})

test('occupancy uses the last iteration when a request made several', () => {
  const iteration = (input, cacheRead) => ({ input_tokens: input, cache_read_input_tokens: cacheRead })
  const single = { input_tokens: 5, cache_read_input_tokens: 100, iterations: [iteration(5, 100)] }
  const multi = {
    input_tokens: 15,
    cache_read_input_tokens: 300,
    iterations: [iteration(5, 100), iteration(10, 200)],
  }
  assert.equal(contextOccupancy(single), 105)
  assert.equal(contextOccupancy(multi), 210)
  const streamlined = streamlineMessage({ ...row('r1', multi), uuid: 'u1' })
  assert.equal(streamlined.message.usage.context, 210)
  assert.equal(streamlined.message.usage.input, 15) // billing keeps the aggregate
})
