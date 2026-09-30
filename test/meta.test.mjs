import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { scanForMetaTags } from '../scripts/lib/meta.mjs'

const SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'scripts',
  'capture-transcript.mjs'
)
const TAG = '<snoop:meta file="transcripts/repro" description="repro"/>'
const PADDED = 'x'.repeat(1000) + '\n' + TAG

const toolResult = (content) => ({
  type: 'user',
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content }] },
})

test('finds a tag past char 500 of a string tool result', () => {
  assert.deepEqual(scanForMetaTags([toolResult(PADDED)]), {
    file: 'transcripts/repro',
    description: 'repro',
  })
})

test('finds a tag in an array-form tool result', () => {
  const msg = toolResult([
    { type: 'image', source: { type: 'base64', data: 'AAAA' } },
    { type: 'text', text: PADDED },
  ])
  assert.equal(scanForMetaTags([msg])?.file, 'transcripts/repro')
})

const withCall = (name, content) => [
  {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name, input: {} }] },
  },
  toolResult(content),
]

test('ignores a tag behind a grep -n line prefix', () => {
  assert.equal(scanForMetaTags([toolResult(`README.md:131:${TAG}`)]), null)
})

test('ignores a tag inside a fenced block of tool output', () => {
  assert.equal(scanForMetaTags([toolResult('**Example:**\n```\n' + TAG + '\n```\n')]), null)
})

test('ignores tool results from content tools', () => {
  assert.equal(scanForMetaTags(withCall('Read', TAG)), null)
  assert.equal(scanForMetaTags(withCall('Grep', TAG)), null)
  assert.equal(scanForMetaTags(withCall('Bash', TAG))?.file, 'transcripts/repro')
})

test('honors a tag emitted as a JSON value, as a JSON-printing CLI emits it', () => {
  const json = JSON.stringify({ file: 'x', metatag: TAG, sequence: 25 }, null, 2)
  assert.equal(scanForMetaTags(withCall('Bash', json))?.file, 'transcripts/repro')
})

test('still honors tags in prompts and assistant text', () => {
  const inPrompt = { type: 'user', message: { role: 'user', content: `tag this ${TAG} please` } }
  const inText = { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: `ok ${TAG}` }] } }
  assert.equal(scanForMetaTags([inPrompt])?.file, 'transcripts/repro')
  assert.equal(scanForMetaTags([inText])?.file, 'transcripts/repro')
})

// Session records shaped like Claude Code's: prompt, Bash call, result, reply.
function sessionTurn(resultContent) {
  const ts = (s) => `2026-09-29T10:00:0${s}.000Z`
  return [
    {
      type: 'user',
      userType: 'external',
      uuid: 'u1',
      timestamp: ts(0),
      message: { role: 'user', content: 'run it' },
    },
    {
      type: 'assistant',
      uuid: 'a1',
      timestamp: ts(1),
      requestId: 'r1',
      message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'x' } }],
      },
    },
    { ...toolResult(resultContent), uuid: 'u2', timestamp: ts(2) },
    {
      type: 'assistant',
      uuid: 'a2',
      timestamp: ts(3),
      requestId: 'r2',
      message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    },
  ]
}

function runHook(projectDir, transcriptPath, hookEvent) {
  const input = JSON.stringify({
    transcript_path: transcriptPath,
    session_id: 's1',
    hook_event_name: hookEvent,
    last_assistant_message: 'done',
  })
  const res = spawnSync('node', [SCRIPT], {
    input,
    env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir },
    encoding: 'utf-8',
  })
  assert.equal(res.status, 0, res.stderr)
}

function setup(records) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'snoop-test-'))
  const transcript = path.join(dir, 'session.jsonl')
  fs.writeFileSync(transcript, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return { dir, transcript }
}

function readCustom(dir) {
  const out = path.join(dir, 'transcripts', 'repro.jsonl')
  assert.ok(fs.existsSync(out), 'transcript not written to the meta tag file path')
  return JSON.parse(fs.readFileSync(out, 'utf-8').split('\n')[0])
}

test('Stop writes to the tag path when the tag is past char 500', () => {
  const { dir, transcript } = setup(sessionTurn(PADDED))
  runHook(dir, transcript, 'Stop')
  assert.equal(readCustom(dir).description, 'repro')
})

test('Stop keeps a tag found in an ESC partial segment', () => {
  // Interrupted segment: the turn ends on a pending tool_use.
  const turn = sessionTurn(PADDED)
  const { dir, transcript } = setup(turn.slice(0, 3).concat({ ...turn[1], uuid: 'a3' }))
  runHook(dir, transcript, 'UserPromptSubmit')

  // Next prompt completes without a tag of its own.
  const next = sessionTurn('no tag here').map((r) => ({ ...r, uuid: r.uuid + 'n' }))
  fs.appendFileSync(transcript, next.map((r) => JSON.stringify(r)).join('\n') + '\n')
  runHook(dir, transcript, 'Stop')

  assert.equal(readCustom(dir).description, 'repro')
  const lines = fs.readFileSync(path.join(dir, 'transcripts', 'repro.jsonl'), 'utf-8')
  assert.ok(!lines.includes('"meta-scan"'), 'partial meta record leaked into transcript')
})

test('Stop ignores a docs example grepped into Bash output (#17)', () => {
  const { dir, transcript } = setup(sessionTurn(`README.md:131:${TAG}\nREADME.md:140:other`))
  runHook(dir, transcript, 'Stop')
  assert.ok(!fs.existsSync(path.join(dir, 'transcripts')), 'capture hijacked by grepped tag')
  assert.ok(fs.existsSync(path.join(dir, '.claude', 'transcripts', 'latest')))
})
