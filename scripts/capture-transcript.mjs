#!/usr/bin/env node
/**
 * Dual-purpose hook for capturing run transcripts.
 * - UserPromptSubmit: Detects ESC interrupts, saves partial transcripts
 * - Stop: Merges partials, captures complete transcript with meta record
 */

import * as fs from 'fs'
import * as path from 'path'

import { readJsonLines, calculateTiming } from './lib/helpers.mjs'
import {
  findLastUserPromptIndex,
  hasToolUse,
  isConversationMessage,
  isInterruptMarker,
  isFinalAssistantMessage,
  shouldSkipMessage,
  streamlineMessage,
  countToolUses,
  getUniqueTools,
  countEscInterrupts,
  buildAgentNameMap,
} from './lib/messages.mjs'
import {
  calculateTokenUsage,
  calculateOutputByModel,
  calculateVisibleOutput,
  calculateDedupedOutput,
} from './lib/tokens.mjs'
import { calculateContextWindow, calculateSubagentContext } from './lib/context.mjs'
import {
  scanForMetaTags,
  normalizeFilePath,
  buildMetaRecord,
  loadSnoopContext,
} from './lib/meta.mjs'

// -----------------------------------------------------------------------------
// Subagent Loading
// -----------------------------------------------------------------------------

function subagentsDirFor(transcriptPath) {
  // Transcript path: /path/to/session-id.jsonl
  // Subagents dir:   /path/to/session-id/subagents/
  return path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')
}

/**
 * Every agent transcript and sidecar under subagents/, collected in ONE
 * recursive walk. Task subagents sit directly in subagents/; Workflow agents
 * sit in subagents/workflows/wf_<runId>/. A flat read finds only the former,
 * which silently drops every agent a workflow spawns. journal.jsonl also lives
 * under workflows/wf_<runId>/ and is not a transcript, hence the agent- prefix.
 */
function walkSubagentFiles(dir, found = { transcripts: [], sidecars: [] }) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    // Missing, unreadable, or removed mid-walk. A subagent directory we cannot
    // read degrades the capture; it must never destroy it, since the caller
    // runs before the transcript is written.
    return found
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walkSubagentFiles(full, found)
    else if (!entry.name.startsWith('agent-')) continue
    else if (entry.name.endsWith('.jsonl')) found.transcripts.push(full)
    else if (entry.name.endsWith('.meta.json')) found.sidecars.push(full)
  }

  return found
}

/** Last-write time, or 0 when it cannot be read (never skip on doubt). */
function mtimeOf(file) {
  try {
    return fs.statSync(file).mtimeMs
  } catch {
    return 0
  }
}

/**
 * Map agentId -> agentType from the agent-<id>.meta.json sidecar Claude Code
 * writes beside each agent transcript. Covers Task and Workflow agents alike,
 * unlike buildAgentNameMap(), which can only name agents reached through a
 * Task tool_use / toolUseResult pair.
 */
function loadAgentTypes(sidecars) {
  const types = new Map()

  for (const file of sidecars) {
    try {
      const { agentType } = JSON.parse(fs.readFileSync(file, 'utf-8'))
      if (agentType) types.set(path.basename(file, '.meta.json'), agentType)
    } catch {
      // Unreadable or malformed sidecar: fall back to the tool_use pairing
    }
  }

  return types
}

/**
 * Raw messages from the agents this turn spawned, each paired with its agent
 * id. A session accumulates every agent it ever ran, so files whose last write
 * predates the turn cannot hold a message inside it and are never opened. The
 * caller still filters the surviving messages by timestamp, since a file may
 * straddle the boundary. Messages stay raw so meta tags are scanned before
 * streamlining truncates them.
 */
async function loadSubagentMessages(transcripts, turnStart) {
  const allMessages = []

  for (const file of transcripts) {
    if (turnStart && mtimeOf(file) < turnStart) continue

    const agentId = path.basename(file, '.jsonl')
    const messages = await readJsonLines(file)

    for (const msg of messages) {
      if (shouldSkipMessage(msg)) continue
      allMessages.push({ agentId, msg })
    }
  }

  return allMessages
}

/**
 * When snoop's previous Stop capture started, in ms, or null if this session
 * has none. Subagent messages since then belong to this capture.
 *
 * Bounding subagents by this turn's first message lost everything that ran
 * between turns. Workflow agents start after the Workflow call returns
 * `async_launched`, so they outlive the turn that spawned them: 740 of 775 real
 * workflow agent messages landed between turns and no capture held them. The
 * same bound lost subagent work in ESC-interrupted segments, which never get a
 * Stop of their own.
 *
 * Claude Code writes a `stop_hook_summary` after each Stop, naming every hook
 * and its duration. Its timestamp minus snoop's duration is when that capture
 * began. That capture read the subagent files after its settle poll, so the
 * two can overlap by up to the hook's own runtime (p95 267 ms); an overlap
 * duplicates a message, where a gap would lose one.
 */
function previousCaptureStart(messages, beforeIndex) {
  for (let i = beforeIndex - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.type !== 'system' || msg.subtype !== 'stop_hook_summary' || !msg.timestamp) continue
    const hook = msg.hookInfos?.find((h) => h.command?.includes('capture-transcript'))
    if (!hook) continue
    const end = new Date(msg.timestamp).getTime()
    if (!Number.isFinite(end)) continue
    return end - (hook.durationMs ?? 0)
  }
  return null
}

// A partial holds streamlined records, so the meta tag scan of its raw segment
// travels alongside them in a record of this type, dropped when merged.
const PARTIAL_META_TYPE = 'meta-scan'

// -----------------------------------------------------------------------------
// Transcript Reading
// -----------------------------------------------------------------------------

const FINAL_ASSISTANT_TIMEOUT_MS = 1000
const FINAL_ASSISTANT_POLL_MS = 50

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Read the session transcript, waiting for the turn's final assistant message
 * to be flushed. Claude Code invokes Stop before that record lands on disk, so
 * a plain read drops the last API call: its output tokens, model, and text.
 *
 * A settled turn ends with an assistant message carrying no pending tool_use.
 * Assistant messages are written one line per content block, so a line holding
 * only a tool_use is mid-turn even though it is an assistant record; breaking
 * on it captures the turn as of that tool call and loses everything after.
 *
 * The file is only re-parsed once it has grown. Session files reach tens of
 * megabytes, and re-reading one to discover that nothing was appended costs
 * more than the poll interval it is meant to fill.
 *
 * Returns { messages, settled }. On timeout the caller still gets what exists,
 * flagged so the short token counts are not mistaken for the real ones.
 */
async function readSettledTranscript(transcriptPath) {
  const deadline = Date.now() + FINAL_ASSISTANT_TIMEOUT_MS
  const sizeOf = () => {
    try {
      return fs.statSync(transcriptPath).size
    } catch {
      return -1
    }
  }

  let messages = await readJsonLines(transcriptPath)
  let size = sizeOf()

  const isSettled = () => isFinalAssistantMessage(messages.filter(isConversationMessage).at(-1))

  while (!isSettled() && Date.now() < deadline) {
    await sleep(FINAL_ASSISTANT_POLL_MS)

    const grown = sizeOf()
    if (grown === size) continue
    size = grown
    messages = await readJsonLines(transcriptPath)
  }

  return { messages, settled: isSettled() }
}

// -----------------------------------------------------------------------------
// Hook Handlers
// -----------------------------------------------------------------------------

async function handleUserPromptSubmit(transcriptPath, partialFile) {
  const messages = await readJsonLines(transcriptPath)

  // Find the user prompt that started this flow
  const startIndex = findLastUserPromptIndex(messages)
  if (startIndex < 0) return

  // The flow was cut short by ESC when it ends on a pending tool_use, or when
  // Claude Code wrote its interrupt marker. The marker is the only sign of an
  // ESC during text or thinking, where no tool_use is pending: that was 8 of 27
  // real interrupts, each lost with its segment before the marker was checked.
  // An interrupted flow never gets a Stop, so nothing else would capture it.
  const lastAssistant = messages.findLast((m) => m.type === 'assistant')
  const segment = messages.slice(startIndex)
  if (!hasToolUse(lastAssistant) && !segment.some(isInterruptMarker)) {
    return
  }

  // Extract the partial flow, scanning for meta tags before streamlining
  const raw = segment.filter((m) => !shouldSkipMessage(m))
  const partial = raw.map(streamlineMessage)
  const meta = scanForMetaTags(raw)
  if (meta) partial.push({ type: PARTIAL_META_TYPE, meta })

  // Create interrupt marker
  const marker = {
    type: 'interrupt',
    marker: '═══════════════════ ⚠️ USER HIT ESC ═══════════════════',
    timestamp: new Date().toISOString(),
  }

  // Append to existing partial or create new
  const existingPartial = fs.existsSync(partialFile) ? await readJsonLines(partialFile) : []

  const combined = [...existingPartial, ...partial, marker]
  const output = combined.map((m) => JSON.stringify(m)).join('\n') + '\n'
  fs.writeFileSync(partialFile, output)
}

/**
 * Truncate and normalize the Stop hook's last_assistant_message for the meta
 * record. Collapses internal whitespace into single spaces so the preview
 * stays on one line, then trims to maxChars characters.
 */
function modelShortcode(modelId) {
  const m = modelId.match(/claude-(sonnet|opus|haiku|fable|mythos)-(\d+)(?:-(\d+))?/)
  if (!m) return modelId
  const letter = { sonnet: 's', opus: 'o', haiku: 'h', fable: 'f', mythos: 'm' }[m[1]]
  return letter + m[2] + (m[3] ?? '')
}

/**
 * Returns null only when Claude Code supplied no final assistant message, which
 * is how a failed turn is identified downstream. A message that exists but
 * collapses to nothing returns the empty string, so a blank reply is never
 * mistaken for a turn that never replied.
 */
function buildLastAssistantPreview(raw, maxChars = 200) {
  if (typeof raw !== 'string') return null
  const collapsed = raw.replace(/\s+/g, ' ').trim()
  return collapsed.length <= maxChars ? collapsed : collapsed.slice(0, maxChars - 1) + '…'
}

async function handleStop(
  transcriptPath,
  partialFile,
  outputDir,
  projectDir,
  lastAssistantMessage,
  hookEvent
) {
  // Stamped before the settle poll so its wait never inflates the duration.
  const hookTime = new Date().toISOString()

  // StopFailure fires when the API call errored, so no final assistant message
  // is coming. Read once rather than waiting out the timeout.
  const isFailure = hookEvent === 'StopFailure'
  const { messages, settled } = isFailure
    ? { messages: await readJsonLines(transcriptPath), settled: false }
    : await readSettledTranscript(transcriptPath)
  const startIndex = findLastUserPromptIndex(messages)

  if (startIndex < 0) {
    return { decision: 'approve', systemMessage: '' }
  }

  // Generate transcript ID
  const transcriptId = Array.from({ length: 8 }, () =>
    'abcdefghijklmnopqrstuvwxyz0123456789'.charAt(Math.floor(Math.random() * 36))
  ).join('')

  // Load any existing partial. readJsonLines skips malformed lines, so a
  // partial truncated by an interrupted write costs its last record rather than
  // throwing and stranding the file, which would fail every later Stop too.
  let combined = []
  let partialMeta = null
  if (fs.existsSync(partialFile)) {
    for (const record of await readJsonLines(partialFile)) {
      if (record.type === PARTIAL_META_TYPE) partialMeta = record.meta
      else combined.push(record)
    }
    fs.unlinkSync(partialFile)
  }

  // Add current segment
  const currentRaw = messages.slice(startIndex).filter((m) => !shouldSkipMessage(m))
  const current = currentRaw.map(streamlineMessage)
  combined.push(...current)

  // Load and append subagent messages written since the previous capture, which
  // takes in agents that ran between turns. The first capture in a session has
  // no previous one and falls back to this turn's first message.
  const turnStart = current[0]?.timestamp ? new Date(current[0].timestamp).getTime() : 0
  const since = previousCaptureStart(messages, startIndex) ?? turnStart
  const subagentFiles = walkSubagentFiles(subagentsDirFor(transcriptPath))
  const subagentRaw = (await loadSubagentMessages(subagentFiles.transcripts, since)).filter(
    ({ msg }) => {
      if (!msg.timestamp || !since) return true
      return new Date(msg.timestamp).getTime() >= since
    }
  )
  const subagentMessages = subagentRaw.map(({ agentId, msg }) => ({
    ...streamlineMessage(msg),
    subagent: agentId,
  }))
  combined.push(...subagentMessages)

  // Scan raw records for meta tags, since streamlining truncates tool results.
  // Order matches combined: partial, then current, then subagents; last wins.
  const metaInfo =
    scanForMetaTags([...currentRaw, ...subagentRaw.map(({ msg }) => msg)]) ?? partialMeta
  const snoopContext = loadSnoopContext(projectDir)

  // Determine output path
  let outputFile
  let isCustomPath = false
  if (metaInfo?.file) {
    try {
      const normalizedPath = normalizeFilePath(metaInfo.file)
      // Custom paths are relative to project root, not transcripts dir
      outputFile = path.join(projectDir, normalizedPath)
      isCustomPath = true

      // Create subdirectories if needed
      const outputFileDir = path.dirname(outputFile)
      fs.mkdirSync(outputFileDir, { recursive: true })
    } catch (err) {
      // Invalid path, fall back to default
      console.error(`Warning: ${err.message}. Using default path.`)
      outputFile = path.join(outputDir, `${transcriptId}.jsonl`)
    }
  } else {
    outputFile = path.join(outputDir, `${transcriptId}.jsonl`)
  }

  // Calculate stats
  // Main-chain records only: subagent messages can now predate the prompt, and
  // time spent between turns is not part of this turn.
  const timing = calculateTiming(
    combined.filter((m) => !m.subagent),
    hookTime
  )
  const msgCount = combined.length
  const toolCount = countToolUses(combined)
  const uniqueTools = getUniqueTools(combined)
  const escCount = countEscInterrupts(combined)
  const tokens = calculateTokenUsage(combined)
  tokens.visibleOutput = calculateVisibleOutput(combined)
  tokens.dedupedOutput = calculateDedupedOutput(combined)
  const outputByModel = calculateOutputByModel(combined)
  // Occupancy comes from the whole session file, not `combined`. `combined` is
  // this turn's flow, which is enough for the current reading but cannot see a
  // peak or a compaction from earlier in the session. Subagent occupancy comes
  // from `subagentMessages`, which carry the agent ids and their own models.
  const contextWindow = calculateContextWindow(messages)
  const subagentIds = Array.from(new Set(subagentMessages.map((m) => m.subagent))).sort()
  // Sidecars only ever name ids this turn used, so skip the reads when it used none.
  const agentTypes = subagentIds.length ? loadAgentTypes(subagentFiles.sidecars) : new Map()
  const agentNameMap = subagentIds.length ? buildAgentNameMap(combined) : new Map()
  const nameForAgent = (id) => agentTypes.get(id) || agentNameMap.get(id) || null
  const subagentNames = [...new Set(subagentIds.map((id) => nameForAgent(id) || id))].sort()
  const subagentContext = calculateSubagentContext(subagentMessages, nameForAgent)

  // Build meta record
  const metaRecord = buildMetaRecord(
    {
      transcriptId,
      timing,
      messageCount: msgCount,
      toolCount,
      tools: uniqueTools,
      escInterrupts: escCount,
      tokens,
      outputByModel,
      contextWindow,
      subagentContext,
      subagents: subagentNames,
      // A failed turn produced no final assistant message. Whatever Claude Code
      // hands the hook on StopFailure, the field stays absent: consumers key
      // failure detection on that absence.
      lastAssistantPreview: isFailure ? null : buildLastAssistantPreview(lastAssistantMessage),
      // The final assistant message never landed. Token counts, outputByModel,
      // and the preview are short. Say so rather than reporting them as whole.
      incompleteCapture: !settled && !isFailure,
    },
    metaInfo,
    snoopContext
  )

  // Write output (meta record first, then messages)
  const outputLines = [JSON.stringify(metaRecord), ...combined.map((m) => JSON.stringify(m))]
  fs.writeFileSync(outputFile, outputLines.join('\n') + '\n')

  // Only update latest pointer for default-named transcripts
  if (!isCustomPath) {
    fs.writeFileSync(path.join(outputDir, 'latest'), outputFile)
  }

  // Cleanup old transcripts (keep last 10) - only prune files directly in outputDir
  if (!isCustomPath) {
    const files = fs
      .readdirSync(outputDir)
      .filter((f) => {
        const fullPath = path.join(outputDir, f)
        return (
          f.endsWith('.jsonl') && !f.startsWith('.') && fs.statSync(fullPath).isFile() // Not a directory
        )
      })
      .map((f) => ({ name: f, time: fs.statSync(path.join(outputDir, f)).mtime }))
      .sort((a, b) => b.time.getTime() - a.time.getTime())

    for (const file of files.slice(10)) {
      fs.unlinkSync(path.join(outputDir, file.name))
    }
  }

  // Build status line
  const truncated = !settled && !isFailure ? '⚠️ incomplete | ' : ''
  const interrupted = escCount > 0 ? `⚠️ ${escCount}x ESC | ` : ''
  const toolList = uniqueTools.join(', ')

  // Build token breakdown, skipping 0 values
  const breakdownParts = []
  if (tokens.input > 0) breakdownParts.push(`${tokens.input.toLocaleString()} p`)
  if (tokens.cache5m > 0) breakdownParts.push(`${tokens.cache5m.toLocaleString()} cw5m`)
  if (tokens.cache1h > 0) breakdownParts.push(`${tokens.cache1h.toLocaleString()} cw1h`)
  if (tokens.cacheRead > 0) breakdownParts.push(`${tokens.cacheRead.toLocaleString()} cr`)
  const cacheEfficiency =
    tokens.totalInput > 0 ? Math.round((tokens.cacheRead / tokens.totalInput) * 100) : 0
  if (cacheEfficiency > 0) breakdownParts.push(`${cacheEfficiency}% ce`)
  const breakdown = breakdownParts.length > 0 ? ` (${breakdownParts.join(' / ')})` : ''
  const modelEntries = Object.entries(outputByModel)
  let modelBreakdown = ''
  if (modelEntries.length > 1) {
    const total = modelEntries.reduce((s, [, n]) => s + n, 0)
    modelBreakdown =
      ' | ' +
      modelEntries
        .sort((a, b) => b[1] - a[1])
        .map(([model, n]) => `${Math.round((n / total) * 100)}% ${modelShortcode(model)}`)
        .join(' / ')
  }
  // dedupedOutput, not tokens.output: the parts must sum to the displayed
  // total, and tokens.output undercounts subagents. visibleOutput is a
  // chars/4 estimate, so on a turn dominated by one big tool_use it can
  // overshoot the API-reported total. Showing it then would print parts that
  // exceed their own sum, so drop the breakdown rather than clamp it into a lie.
  const outTotal = tokens.dedupedOutput
  const showBreakdown = outTotal > 0 && tokens.visibleOutput <= outTotal
  const outBreakdown = showBreakdown
    ? ` (${tokens.visibleOutput.toLocaleString()} v / ${(outTotal - tokens.visibleOutput).toLocaleString()} r)`
    : ''
  const tokenSummary = `${tokens.totalInput.toLocaleString()} in${breakdown} | ${outTotal.toLocaleString()} out${outBreakdown}${modelBreakdown}`

  const subagentCount = subagentIds.length
  const subagentInfo =
    subagentCount > 0 ? ` | ${subagentCount} si (${subagentNames.join(', ')})` : ''
  const toolInfo = toolCount > 0 ? ` | ${toolCount} ti (${toolList})` : ''

  // Include custom path indicator if applicable
  const pathIndicator = isCustomPath ? ` → ${metaInfo.file}` : ''

  return {
    decision: 'approve',
    systemMessage: `[snoop] ${transcriptId}${pathIndicator} | ${timing.durationFormatted} | ${truncated}${interrupted}${msgCount} msgs | ${tokenSummary}${subagentInfo}${toolInfo}`,
  }
}

// -----------------------------------------------------------------------------
// Entry Point
// -----------------------------------------------------------------------------

async function main() {
  let inputData = ''
  for await (const chunk of process.stdin) {
    inputData += chunk
  }

  const input = JSON.parse(inputData)
  const transcriptPath = input.transcript_path
  const sessionId = input.session_id || 'unknown'
  const hookEvent = input.hook_event_name || 'Stop'

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    process.exit(0)
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd()
  const outputDir = path.join(projectDir, '.claude', 'transcripts')
  const partialFile = path.join(outputDir, `.partial_${sessionId}.jsonl`)

  fs.mkdirSync(outputDir, { recursive: true })

  // Ensure transcripts are not committed
  const gitignorePath = path.join(outputDir, '.gitignore')
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, '*\n')
  }

  if (hookEvent === 'UserPromptSubmit') {
    await handleUserPromptSubmit(transcriptPath, partialFile)
    process.exit(0)
  }

  const result = await handleStop(
    transcriptPath,
    partialFile,
    outputDir,
    projectDir,
    input.last_assistant_message,
    hookEvent
  )
  if (result.systemMessage) {
    console.log(JSON.stringify(result))
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
