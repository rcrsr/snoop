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
 *
 * Everything here comes from the session transcript. Process argv and
 * settings.json were tried and dropped: ANTHROPIC_MODEL and a mid-session
 * /model switch both override them, and neither leaves a trace in either place.
 */

const WINDOW_1M = 1_000_000
const WINDOW_200K = 200_000

// Autocompact fires at window - min(maxOutputTokens, 20000) - 13000. Both
// reserves are constants in Claude Code; the output reserve saturates at 20k for
// every current model. 1M resolves to 967,000, which matches the published
// Sonnet 5 figure, so the reconstruction is confirmed against a documented value.
const OUTPUT_RESERVE = 20_000
const COMPACT_RESERVE = 13_000

// Maximum input window per model, keyed by family-version, from Anthropic's
// model table. `message.model` names the model exactly, so a listed model needs
// no inference. An unlisted model resolves only from its own readings.
const MODEL_WINDOWS = {
  'fable-5-1': WINDOW_1M,
  'fable-5': WINDOW_1M,
  'mythos-5-1': WINDOW_1M,
  'mythos-5': WINDOW_1M,
  'opus-5-5': WINDOW_1M,
  'opus-5': WINDOW_1M,
  'opus-4-8': WINDOW_1M,
  'opus-4-7': WINDOW_1M,
  'opus-4-6': WINDOW_1M,
  'sonnet-5-5': WINDOW_1M,
  'sonnet-5': WINDOW_1M,
  'sonnet-4-6': WINDOW_1M,
  'haiku-4-5': WINDOW_200K,
}

/**
 * Window size from a model ID, or null for a model not in the table. Tolerates
 * a date suffix (`claude-haiku-4-5-20251001`) and a provider prefix
 * (`us.anthropic.claude-opus-4-8`). The minor version is one or two digits, so
 * a date directly after the major version is never read as a minor version.
 */
export function modelWindow(modelId) {
  const m = typeof modelId === 'string' && modelId.match(/claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?!\d)/)
  if (!m) return null
  return MODEL_WINDOWS[m[3] ? `${m[1]}-${m[2]}-${m[3]}` : `${m[1]}-${m[2]}`] ?? null
}

/**
 * Prompt tokens occupying the window for one request. Accepts raw API field
 * names and the streamlined names written by streamlineMessage(), since this
 * runs against both the session file and snoop's own captured transcripts.
 */
export function contextOccupancy(usage) {
  if (!usage) return 0
  if (typeof usage.context === 'number') return usage.context
  // `iterations` lists each API iteration a request made. Every observed row
  // has one, but with several the top-level fields may aggregate them, which
  // overstates the window. The last iteration's prompt is the one occupying it.
  const { iterations } = usage
  if (Array.isArray(iterations) && iterations.length > 1) usage = iterations[iterations.length - 1]
  const input = usage.input_tokens ?? usage.input ?? 0
  const cacheCreate = usage.cache_creation_input_tokens ?? usage.cacheCreate ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? usage.cacheRead ?? 0
  return input + cacheCreate + cacheRead
}

const isMainAssistant = (msg) =>
  msg?.type === 'assistant' && !!msg.message?.usage && !msg.isSidechain && !msg.subagent

/**
 * The window a reading on `model` was measured against, and how it is known.
 *
 * - `model`: the model table lists it.
 * - `observed`: unlisted, but a reading on this same model passed 200k, which
 *   only a 1M window allows. Scoped to the model, so a peak from before a
 *   /model switch never inflates the window of the model switched to.
 * - `unknown`: unlisted and never past 200k. Size stays null rather than a
 *   guessed denominator; the token counts are still exact.
 */
function resolveWindow(model, modelPeak) {
  const listed = modelWindow(model)
  // A reading above the listed size means the table is wrong for this model.
  if (listed && modelPeak <= listed) return { size: listed, basis: 'model' }
  if (modelPeak > WINDOW_200K) return { size: WINDOW_1M, basis: 'observed' }
  return { size: null, basis: 'unknown' }
}

const percentOf = (n, size) =>
  size ? Math.min(100, Math.max(0, Math.round((n / size) * 100))) : null

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
 * occupancy, and only the peak shows how close it came to the limit. It is
 * measured against its own row's model, which differs from `model` after a
 * /model switch, so `peakModel` names it.
 *
 * Rows that occupy nothing are skipped rather than taken as a zero reading. A
 * usage object can be present and empty on an error response, and a turn that
 * really did fill the window must not report 0% because its last row failed.
 */
export function calculateContextWindow(messages) {
  let used = 0
  let model = null
  let peak = 0
  let peakModel = null
  const peakByModel = new Map()

  for (const msg of messages) {
    if (!isMainAssistant(msg)) continue
    const occupancy = contextOccupancy(msg.message.usage)
    if (occupancy === 0) continue
    used = occupancy
    model = msg.message.model ?? null
    peakByModel.set(model, Math.max(peakByModel.get(model) ?? 0, occupancy))
    if (occupancy > peak) {
      peak = occupancy
      peakModel = model
    }
  }

  if (peak === 0) return null

  const { size, basis } = resolveWindow(model, peakByModel.get(model))
  const peakSize = resolveWindow(peakModel, peakByModel.get(peakModel)).size
  const threshold = size ? size - OUTPUT_RESERVE - COMPACT_RESERVE : null

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
    usedPercentage: percentOf(used, size),
    peakPercentage: percentOf(peak, peakSize),
    model,
    peakModel,
    compactThreshold: threshold,
    headroom: threshold === null ? null : Math.max(0, threshold - used),
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
 * spawned by an opus session is traced back. `size` is the window of the model
 * that produced the peak, resolved the same way as the main session's.
 */
export function calculateSubagentContext(messages, nameFor = () => null, detailsFor = () => ({})) {
  const byAgent = new Map()

  for (const msg of messages) {
    const agentId = msg.subagent
    if (!agentId || msg.type !== 'assistant' || !msg.message?.usage) continue

    const entry = byAgent.get(agentId) ?? {
      agentId,
      peak: 0,
      peakModel: null,
      models: new Set(),
      peakByModel: new Map(),
    }
    const occupancy = contextOccupancy(msg.message.usage)
    const model = msg.message.model ?? null
    if (model) entry.models.add(model)
    entry.peakByModel.set(model, Math.max(entry.peakByModel.get(model) ?? 0, occupancy))
    if (occupancy > entry.peak) {
      entry.peak = occupancy
      entry.peakModel = model
    }
    byAgent.set(agentId, entry)
  }

  return Array.from(byAgent.values())
    .map(({ agentId, peak, peakModel, models, peakByModel }) => {
      const { size } = resolveWindow(peakModel, peakByModel.get(peakModel) ?? 0)
      // The agent type is what makes a reading traceable to the work behind it.
      const name = nameFor(agentId)
      return {
        agentId,
        peak,
        size,
        peakPercentage: percentOf(peak, size),
        models: Array.from(models).sort(),
        ...(name && { name }),
        ...detailsFor(agentId),
      }
    })
    .sort((a, b) => b.peak - a.peak)
}
