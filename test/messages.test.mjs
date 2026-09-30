import { test } from 'node:test'
import assert from 'node:assert/strict'

import { buildAgentNameMap, shouldSkipMessage, streamlineMessage } from '../scripts/lib/messages.mjs'

// Bookkeeping record types Claude Code 2.1.285 interleaves with the
// conversation, shaped like the real records minus their payloads. None
// carries a `message` body.
const BOOKKEEPING = {
  attachment: { attachment: { type: 'hook_additional_context' } },
  mode: { mode: 'default' },
  'permission-mode': { permissionMode: 'auto' },
  'last-prompt': { lastPrompt: 'hi' },
  'ai-title': { aiTitle: 'Fix a bug' },
  'file-history-snapshot': { messageId: 'm1', snapshot: {} },
  'file-history-delta': { messageId: 'm1', delta: {} },
  summary: { summary: 'Earlier work', leafUuid: 'u1' },
  progress: { data: { type: 'hook_progress' } },
  system: { subtype: 'stop_hook_summary', hookInfos: [] },
  'queue-operation': { operation: 'enqueue' },
  'pr-link': { url: 'https://github.com/o/r/pull/1' },
  'agent-name': { agentName: 'reviewer' },
  'atis-latch': { latched: true },
  'cost-state': { costUSD: 0.12 },
  'fork-context-ref': { ref: 'agent-a' },
}

test('every known bookkeeping record type is skipped', () => {
  for (const [type, fields] of Object.entries(BOOKKEEPING)) {
    const record = { type, uuid: 'x', timestamp: '2026-09-29T10:00:00.000Z', ...fields }
    assert.ok(shouldSkipMessage(record), `${type} was kept`)
  }
})

test('conversation records and interrupt markers are kept, an unknown type is not', () => {
  assert.ok(!shouldSkipMessage({ type: 'user', message: { role: 'user', content: 'hi' } }))
  assert.ok(!shouldSkipMessage({ type: 'assistant', message: { role: 'assistant', content: [] } }))
  assert.ok(!shouldSkipMessage({ type: 'interrupt', marker: 'ESC' }))
  // A user record with no body is bookkeeping, whatever its type says.
  assert.ok(shouldSkipMessage({ type: 'user' }))
  assert.ok(shouldSkipMessage({ type: 'some-future-type', data: {} }))
})

const resultRow = (content) => ({
  type: 'user',
  uuid: 'u1',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
})

test('streamlining truncates both tool result forms to 500 chars', () => {
  const long = 'y'.repeat(2000)
  const [asString] = streamlineMessage(resultRow(long)).message.content
  assert.equal(asString.content, 'y'.repeat(500) + '...')

  const [asArray] = streamlineMessage(resultRow([{ type: 'text', text: long }])).message.content
  assert.equal(asArray.content[0].text, 'y'.repeat(500) + '...')

  const [short] = streamlineMessage(resultRow('ok')).message.content
  assert.equal(short.content, 'ok')
})

test('streamlining elides base64 images and keeps url images', () => {
  const b64 = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'A'.repeat(600000) } }
  const url = { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } }
  const [inResult] = streamlineMessage(resultRow([b64, url])).message.content
  assert.equal(inResult.content[0].source.data, '<elided 600000 chars>')
  assert.equal(inResult.content[0].source.media_type, 'image/png')
  assert.deepEqual(inResult.content[1], url)

  const prompt = { type: 'user', message: { role: 'user', content: [b64] } }
  assert.equal(streamlineMessage(prompt).message.content[0].source.data, '<elided 600000 chars>')
})

test('streamlining keeps the transcript fields and drops the rest', () => {
  const row = streamlineMessage({
    type: 'assistant',
    uuid: 'a1',
    parentUuid: 'p1',
    timestamp: '2026-09-29T10:00:00.000Z',
    requestId: 'r1',
    cwd: '/secret/path',
    version: '2.1.285',
    message: {
      role: 'assistant',
      model: 'claude-opus-5-5',
      id: 'msg_1',
      content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' }, caller: 'x' }],
      usage: { input_tokens: 2, output_tokens: 9, cache_read_input_tokens: 100, cache_creation_input_tokens: 10 },
    },
  })
  assert.deepEqual(Object.keys(row).sort(), ['message', 'parentUuid', 'requestId', 'timestamp', 'type', 'uuid'])
  assert.deepEqual(row.message.content[0], { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } })
  assert.equal(row.message.usage.context, 112)
  assert.equal(row.message.id, undefined)
})

test('buildAgentNameMap pairs Agent and Task calls with their results', () => {
  const call = (id, name, type) => ({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input: { subagent_type: type } }] },
  })
  const result = (id, agentId) => ({
    type: 'user',
    toolUseResult: { agentId },
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'done' }] },
  })
  const names = buildAgentNameMap([
    call('t1', 'Agent', 'Explore'),
    call('t2', 'Task', 'reviewer'),
    call('t3', 'Bash', 'ignored'),
    result('t1', 'aaa'),
    result('t2', 'bbb'),
    result('t3', 'ccc'),
  ])
  assert.deepEqual(Object.fromEntries(names), { 'agent-aaa': 'Explore', 'agent-bbb': 'reviewer' })
})
