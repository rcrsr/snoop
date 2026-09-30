import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  calculateDedupedOutput,
  calculateOutputByModel,
  calculateOutputBySpeed,
  calculateThinkingOutput,
  calculateVisibleOutput,
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

test('the closing line wins regardless of line order or timestamps', () => {
  const partial = { ...row('r1', usage(1)), timestamp: '2026-09-29T10:00:05.000Z' }
  const closing = { ...row('r1', usage(276)), timestamp: '2026-09-29T10:00:01.000Z' }
  assert.equal(calculateDedupedOutput([partial, closing, partial]), 276)
  assert.equal(calculateDedupedOutput([closing, partial]), 276)
})

test('output by model dedupes per request and covers subagents', () => {
  const rows = [
    row('r1', usage(1)),
    row('r1', usage(100)),
    { ...row('r2', usage(40), { subagent: 'agent-a' }), message: { ...row('r2', usage(40)).message, model: 'claude-haiku-4-5' } },
    { type: 'assistant', message: { role: 'assistant', content: [], usage: usage(7) } },
  ]
  assert.deepEqual(calculateOutputByModel(rows), { 'claude-opus-5-5': 100, 'claude-haiku-4-5': 40 })
})

test('visible output counts text and tool calls, skips thinking and repeated uuids', () => {
  const line = (uuid, block) => ({ type: 'assistant', uuid, requestId: 'r1', message: { role: 'assistant', content: [block] } })
  const rows = [
    line('u1', { type: 'thinking', thinking: 'z'.repeat(4000) }),
    line('u2', { type: 'text', text: 'x'.repeat(40) }), // 10 tokens
    line('u2', { type: 'text', text: 'x'.repeat(40) }), // same uuid, dropped
    line('u3', { type: 'tool_use', name: 'Bash', input: { command: 'ls' } }), // 4 + 16 chars
  ]
  assert.equal(calculateVisibleOutput(rows), 15)
})
