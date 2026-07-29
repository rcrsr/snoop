import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFileSync } from 'child_process'

/**
 * Context window occupancy from API-reported usage
 *
 * Claude Code hands statuslines a `context_window` object and hands hooks
 * nothing, so a hook has to rebuild it. The rebuild is exact rather than
 * estimated: v2.1.220 derives its own `used_percentage` from
 *   input_tokens + cache_creation_input_tokens + cache_read_input_tokens
 * of the most recent message carrying usage, over the model's window size.
 * Same formula, same source row.
 *
 * Cumulative token totals (lib/tokens.mjs) and occupancy answer different
 * questions and must not be confused. Totals sum every request ever made and
 * only grow; occupancy is a single request's prompt size, and it falls when the
 * conversation compacts. A session can bill 4M tokens while occupying 90k.
 */

const WINDOW_1M = 1_000_000
const WINDOW_DEFAULT = 200_000

// Autocompact fires at window - min(maxOutputTokens, 20000) - 13000. Both
// reserves are constants in Claude Code; the output reserve saturates at 20k for
// every current model. 1M resolves to 967,000, which matches the published
// Sonnet 5 figure, so the reconstruction is confirmed against a documented value.
const OUTPUT_RESERVE = 20_000
const COMPACT_RESERVE = 13_000

/**
 * Prompt tokens occupying the window for one request. Accepts raw API field
 * names and the streamlined names written by streamlineMessage(), since this
 * runs against both the session file and snoop's own captured transcripts.
 */
export function contextOccupancy(usage) {
  if (!usage) return 0
  if (typeof usage.context === 'number') return usage.context
  const input = usage.input_tokens ?? usage.input ?? 0
  const cacheCreate = usage.cache_creation_input_tokens ?? usage.cacheCreate ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? usage.cacheRead ?? 0
  return input + cacheCreate + cacheRead
}

const isMainAssistant = (msg) =>
  msg?.type === 'assistant' && !!msg.message?.usage && !msg.isSidechain && !msg.subagent

/**
 * The window size is not recoverable from `message.model`: a session running
 * opus[1m] records plain `claude-opus-5`, verified on a session that reached
 * 989,865 tokens and on one launched with an explicit `--model opus[1m]`.
 * Three signals recover it, strongest first. Only the first is proof, so the
 * basis travels with the number and callers mark an assumed window rather than
 * publishing a confident percentage against a guessed denominator.
 */
function inferWindow(peak) {
  if (peak > WINDOW_DEFAULT) return { size: WINDOW_1M, basis: 'observed' }

  // A model named on the command line overrides the configured default, so the
  // two must not be consulted together: `--model haiku` against a settings.json
  // of `opus[1m]` is a 200k session, and reading both would call it 1M.
  const launched = launchModel()
  const declared = launched ?? configuredModel()

  // These signals can only raise the window, never rule 1M out. A declared
  // model without the suffix may still be natively 1M, so the absence of `[1m]`
  // leaves the window assumed rather than proving 200k.
  if (declared?.includes('[1m]')) {
    return { size: WINDOW_1M, basis: launched ? 'argv' : 'settings' }
  }
  return { size: WINDOW_DEFAULT, basis: 'assumed' }
}

/**
 * The model named in the running process's own argv. Claude Code exports its pid
 * as CLAUDE_PID, so the flags it launched with are readable from the process
 * table. Silent on any failure: ps is absent on some platforms, and the flag is
 * often not passed at all.
 */
function launchModel() {
  const pid = process.env.CLAUDE_PID
  if (!pid || !/^\d+$/.test(pid)) return null
  try {
    const argv = execFileSync('ps', ['-o', 'args=', '-p', pid], {
      encoding: 'utf-8',
      timeout: 500,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return argv.match(/--model[= ]+(\S+)/)?.[1] ?? null
  } catch {
    return null
  }
}

/** Settings precedence, narrowest first. A `/model` switch mid-session is invisible here. */
function configuredModel() {
  const dir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const candidates = [
    path.join(dir, '.claude', 'settings.local.json'),
    path.join(dir, '.claude', 'settings.json'),
    path.join(os.homedir(), '.claude', 'settings.json'),
  ]
  for (const file of candidates) {
    try {
      const model = JSON.parse(fs.readFileSync(file, 'utf-8')).model
      if (typeof model === 'string' && model) return model
    } catch {}
  }
  return null
}

/**
 * Occupancy of the live conversation, plus its high-water mark.
 *
 * The reading is the last main-chain assistant message in file order, matching
 * Claude Code's own extractor and snoop's settle contract, which defines the
 * leaf as the last conversation record. Sorting by timestamp would be wrong for
 * the same reason lib/tokens.mjs refuses to: a request's lines are not reliably
 * ordered by time, and on a rewound session the chronologically last row belongs
 * to an abandoned branch.
 *
 * `peak` is a maximum, so it needs no ordering at all. It survives compaction,
 * which is the point: a session that compacted at 99% reports a 22% current
 * occupancy, and only the peak shows how close it came to the limit.
 *
 * Rows that occupy nothing are skipped rather than taken as a zero reading. A
 * usage object can be present and empty on an error response, and a turn that
 * really did fill the window must not report 0% because its last row failed.
 */
export function calculateContextWindow(messages) {
  let used = 0
  let peak = 0
  let model = null

  for (const msg of messages) {
    if (!isMainAssistant(msg)) continue
    const occupancy = contextOccupancy(msg.message.usage)
    if (occupancy === 0) continue
    used = occupancy
    peak = Math.max(peak, occupancy)
    model = msg.message.model ?? null
  }

  if (peak === 0) return null

  const { size, basis } = inferWindow(peak)
  const threshold = size - OUTPUT_RESERVE - COMPACT_RESERVE
  const pct = (n) => Math.min(100, Math.max(0, Math.round((n / size) * 100)))

  // Compaction discards context mid-session, so a bare occupancy reading
  // understates what the session actually held. Claude Code records the exact
  // amounts, and this event's own drop is pre minus post. The recorded
  // cumulativeDroppedTokens is not usable per event: it is a running total, so
  // listing it per boundary would double-count every compaction after the first.
  const compactions = messages
    .filter((m) => m.subtype === 'compact_boundary' && m.compactMetadata)
    .map(({ compactMetadata: c }) => ({
      trigger: c.trigger,
      preTokens: c.preTokens ?? 0,
      postTokens: c.postTokens ?? 0,
      droppedTokens: Math.max(0, (c.preTokens ?? 0) - (c.postTokens ?? 0)),
    }))

  return {
    used,
    peak,
    size,
    windowBasis: basis,
    usedPercentage: pct(used),
    peakPercentage: pct(peak),
    model,
    compactThreshold: threshold,
    headroom: Math.max(0, threshold - used),
    compactions,
  }
}

/**
 * Per-subagent occupancy and model.
 *
 * A subagent runs its own context window, so these are separate readings, not
 * slices of the parent's. Each is a maximum over that agent's own requests:
 * subagent transcripts are appended per agent and a maximum needs no ordering.
 * Model comes from the agent's own messages, which is how a haiku subagent
 * spawned by an opus session is traced back.
 */
export function calculateSubagentContext(messages, nameFor = () => null) {
  const byAgent = new Map()

  for (const msg of messages) {
    const agentId = msg.subagent
    if (!agentId || msg.type !== 'assistant' || !msg.message?.usage) continue

    const entry = byAgent.get(agentId) ?? { agentId, peak: 0, models: new Set() }
    entry.peak = Math.max(entry.peak, contextOccupancy(msg.message.usage))
    if (msg.message.model) entry.models.add(msg.message.model)
    byAgent.set(agentId, entry)
  }

  return Array.from(byAgent.values())
    .map(({ agentId, peak, models }) => {
      // The agent type is what makes a reading traceable to the work behind it.
      const name = nameFor(agentId)
      return { agentId, peak, models: Array.from(models).sort(), ...(name && { name }) }
    })
    .sort((a, b) => b.peak - a.peak)
}

