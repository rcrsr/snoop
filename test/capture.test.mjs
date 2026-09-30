import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { findLastUserPromptIndex, isInterruptMarker } from '../scripts/lib/messages.mjs'

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'capture-transcript.mjs'
)

const ts = (s) => new Date(Date.UTC(2026, 8, 29, 10, 0, s)).toISOString()

const prompt = (uuid, s, text) => ({
  type: 'user',
  userType: 'external',
  uuid,
  timestamp: ts(s),
  message: { role: 'user', content: text },
})

const assistant = (uuid, s, requestId, block, extra = {}) => ({
  type: 'assistant',
  uuid,
  timestamp: ts(s),
  requestId,
  message: {
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [block],
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
  },
  ...extra,
})

const toolResult = (uuid, s, id) => ({
  type: 'user',
  userType: 'external',
  uuid,
  timestamp: ts(s),
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] },
})

const text = (t) => ({ type: 'text', text: t })
const toolUse = (id, name) => ({ type: 'tool_use', id, name, input: {} })

const stopSummary = (s, durationMs = 200) => ({
  type: 'system',
  subtype: 'stop_hook_summary',
  timestamp: ts(s),
  hookInfos: [{ command: 'node "${CLAUDE_PLUGIN_ROOT}/scripts/capture-transcript.mjs"', durationMs }],
})

const interruptMarker = (uuid, s) => ({
  type: 'user',
  userType: 'external',
  uuid,
  timestamp: ts(s),
  message: { role: 'user', content: [text('[Request interrupted by user]')] },
})

function setup(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snoop-test-'))
  const transcript = path.join(dir, 'session.jsonl')
  writeJsonl(transcript, records)
  return { dir, transcript }
}

function writeJsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function runHook(dir, transcript, hookEvent) {
  const res = spawnSync('node', [SCRIPT], {
    input: JSON.stringify({
      transcript_path: transcript,
      session_id: 's1',
      hook_event_name: hookEvent,
      last_assistant_message: 'done',
    }),
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
    encoding: 'utf-8',
  })
  assert.equal(res.status, 0, res.stderr)
  return res
}

function readCapture(dir) {
  const outDir = path.join(dir, '.claude', 'transcripts')
  const file = fs.readFileSync(path.join(outDir, 'latest'), 'utf-8').trim()
  const [meta, ...messages] = fs
    .readFileSync(file, 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l))
  return { meta, messages }
}

test('an isMeta string after the prompt does not start the turn', () => {
  const records = [
    prompt('p1', 0, 'file it'),
    assistant('a1', 1, 'r1', toolUse('t1', 'Skill')),
    toolResult('u1', 2, 't1'),
    { ...prompt('m1', 3, '(Re-invocation of /example:skill ...)'), isMeta: true },
  ]
  assert.equal(findLastUserPromptIndex(records), 0)

  const { dir, transcript } = setup([...records, assistant('a2', 4, 'r2', text('done'))])
  runHook(dir, transcript, 'Stop')
  const { meta, messages } = readCapture(dir)
  assert.equal(messages[0].uuid, 'p1')
  assert.deepEqual(meta.tools, ['Skill'])
})

test('a bash-mode turn starts at <bash-input>, not <bash-stdout>', () => {
  const withId = (r, promptId) => ({ ...r, promptId })
  const records = [
    withId(prompt('p0', 0, 'earlier'), 'id0'),
    assistant('a0', 1, 'r0', text('ok')),
    withId(prompt('b1', 2, '<bash-input>ls</bash-input>'), 'id1'),
    withId(prompt('b2', 3, '<bash-stdout>a.txt</bash-stdout><bash-stderr></bash-stderr>'), 'id1'),
  ]
  assert.equal(findLastUserPromptIndex(records), 2)

  const { dir, transcript } = setup([...records, assistant('a1', 4, 'r1', text('done'))])
  runHook(dir, transcript, 'Stop')
  const { messages } = readCapture(dir)
  assert.deepEqual(
    messages.map((m) => m.uuid),
    ['b1', 'b2', 'a1']
  )
})

test('prompts without promptId keep last-match turn start', () => {
  const records = [prompt('p1', 0, 'one'), prompt('p2', 1, 'two')]
  assert.equal(findLastUserPromptIndex(records), 1)
})

test('status line splits output by exact thinking tokens when every request reports them', () => {
  const withThinking = (r, output, thinking) => {
    r.message.usage = { ...r.message.usage, output_tokens: output, output_tokens_details: { thinking_tokens: thinking }, speed: 'standard' }
    return r
  }
  const { dir, transcript } = setup([
    prompt('p1', 0, 'go'),
    withThinking(assistant('a1', 1, 'r1', toolUse('t1', 'Bash')), 400, 300),
    toolResult('u1', 2, 't1'),
    withThinking(assistant('a2', 3, 'r2', text('done')), 100, 20),
  ])
  const res = runHook(dir, transcript, 'Stop')
  assert.match(JSON.parse(res.stdout).systemMessage, /500 out \(180 v \/ 320 r\)/)
  const { meta, messages } = readCapture(dir)
  assert.equal(meta.tokens.thinkingOutput, 320)
  assert.equal(meta.tokens.thinkingExact, true)
  assert.deepEqual(meta.outputBySpeed, { standard: 500 })
  assert.equal(messages.find((m) => m.uuid === 'a1').message.usage.thinking, 300)
})

test('detects the interrupt marker in both content forms', () => {
  assert.ok(isInterruptMarker(interruptMarker('i', 0)))
  assert.ok(isInterruptMarker(prompt('i', 0, '[Request interrupted by user for tool use]')))
  assert.ok(!isInterruptMarker(prompt('i', 0, 'hello')))
})

test('ESC during a text reply is captured as a partial', () => {
  // No tool_use is pending: the only sign of the ESC is the marker.
  const { dir, transcript } = setup([
    prompt('p1', 0, 'explain'),
    assistant('a1', 1, 'r1', text('Partial answ')),
    interruptMarker('i1', 2),
  ])
  runHook(dir, transcript, 'UserPromptSubmit')

  fs.appendFileSync(
    transcript,
    [prompt('p2', 10, 'shorter please'), assistant('a2', 11, 'r2', text('done'))]
      .map((r) => JSON.stringify(r))
      .join('\n') + '\n'
  )
  runHook(dir, transcript, 'Stop')

  const { meta, messages } = readCapture(dir)
  assert.equal(meta.escInterrupts, 1)
  assert.equal(messages[0].uuid, 'p1')
})

test('a completed turn saves no partial', () => {
  const { dir, transcript } = setup([prompt('p1', 0, 'hi'), assistant('a1', 1, 'r1', text('hello'))])
  runHook(dir, transcript, 'UserPromptSubmit')
  assert.ok(!fs.existsSync(path.join(dir, '.claude', 'transcripts', '.partial_s1.jsonl')))
})

test('subagent work between turns lands in the next capture', () => {
  // Turn 1 launches a workflow and ends at 5s. Its agent runs at 20-30s,
  // before the turn 2 prompt at 60s.
  const { dir, transcript } = setup([
    prompt('p1', 0, 'run the workflow'),
    assistant('a1', 1, 'r1', toolUse('t1', 'Workflow')),
    toolResult('u1', 2, 't1'),
    assistant('a2', 3, 'r2', text('launched')),
    stopSummary(5),
    prompt('p2', 60, 'status?'),
    assistant('a3', 61, 'r3', text('done')),
  ])
  const agentDir = path.join(dir, 'session', 'subagents', 'workflows', 'wf_abc')
  writeJsonl(path.join(agentDir, 'agent-x1.jsonl'), [
    { ...prompt('s1', 20, 'task'), isSidechain: true },
    assistant('s2', 30, 'rs', text('agent result'), { isSidechain: true }),
  ])
  writeJsonl(path.join(agentDir, 'agent-x1.meta.json'), [{ agentType: 'reviewer' }])

  runHook(dir, transcript, 'Stop')
  const { meta, messages } = readCapture(dir)
  assert.deepEqual(meta.subagents, ['reviewer'])
  assert.equal(messages.filter((m) => m.subagent === 'agent-x1').length, 2)
  // The turn itself runs from the 60s prompt, not from the agent's 20s start.
  assert.equal(meta.timing.start, ts(60))
})

test('the first capture in a session bounds subagents by the turn start', () => {
  const { dir, transcript } = setup([prompt('p1', 60, 'go'), assistant('a1', 61, 'r1', text('done'))])
  writeJsonl(path.join(dir, 'session', 'subagents', 'agent-old.jsonl'), [
    assistant('s1', 10, 'rs', text('stale'), { isSidechain: true }),
  ])
  runHook(dir, transcript, 'Stop')
  const { meta } = readCapture(dir)
  assert.equal(meta.subagents, undefined)
})
