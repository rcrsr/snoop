/**
 * Token calculation from API-reported usage
 */

function addUsage(usage) {
  return {
    input: usage.input ?? usage.input_tokens ?? 0,
    output: usage.output ?? usage.output_tokens ?? 0,
    cacheCreate: usage.cacheCreate ?? usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cacheRead ?? usage.cache_read_input_tokens ?? 0,
    cache5m: usage.cache5m ?? usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    cache1h: usage.cache1h ?? usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  }
}

const outputOf = (usage) => usage.output_tokens ?? usage.output ?? 0

/**
 * One usage object per requestId: the request's final, complete one.
 *
 * A request spans one JSONL line per content block, and those lines do NOT
 * repeat the same usage. Intermediate lines carry a partial output_tokens and
 * only the closing line carries the total, e.g. 1, 1, 1, 1, 276. Across 5,964
 * real multi-line requests the input and cache fields never vary within a
 * request, and wherever output_tokens varies the maximum is the closing line.
 * Taking the line with the largest output_tokens therefore takes the complete
 * usage object.
 *
 * Selecting by maximum rather than by position makes this independent of array
 * order. Sorting by timestamp, which this used to do, is actively wrong: a
 * closing line can bear an earlier timestamp than a partial one, sort behind
 * it, and lose to it under last-write-wins. That undercounted 16 of 600 real
 * session files, the worst by 2,276 tokens (17.8%).
 */
function finalUsageByRequest(messages, { skipSubagents = false } = {}) {
  const byRequest = new Map()

  for (const msg of messages) {
    if (!msg.requestId || !msg.message?.usage) continue
    if (skipSubagents && msg.subagent) continue

    const prev = byRequest.get(msg.requestId)
    if (!prev || outputOf(msg.message.usage) > outputOf(prev.usage)) {
      byRequest.set(msg.requestId, { usage: msg.message.usage, model: msg.message.model })
    }
  }

  return byRequest
}

export function calculateTokenUsage(messages) {
  const byRequest = finalUsageByRequest(messages, { skipSubagents: true })
  const subagentUsages = []

  for (const msg of messages) {
    if (msg.toolUseResult?.usage) {
      subagentUsages.push(msg.toolUseResult.usage)
    }
  }

  let totalInput = 0
  let totalOutput = 0
  let totalCacheCreate = 0
  let totalCacheRead = 0
  let totalCache5m = 0
  let totalCache1h = 0

  for (const { usage } of byRequest.values()) {
    const u = addUsage(usage)
    totalInput += u.input
    totalOutput += u.output
    totalCacheCreate += u.cacheCreate
    totalCacheRead += u.cacheRead
    totalCache5m += u.cache5m
    totalCache1h += u.cache1h
  }

  for (const usage of subagentUsages) {
    const u = addUsage(usage)
    totalInput += u.input
    totalOutput += u.output
    totalCacheCreate += u.cacheCreate
    totalCacheRead += u.cacheRead
    totalCache5m += u.cache5m
    totalCache1h += u.cache1h
  }

  return {
    input: totalInput,
    output: totalOutput,
    cacheCreate: totalCacheCreate,
    cacheRead: totalCacheRead,
    cache5m: totalCache5m,
    cache1h: totalCache1h,
    totalInput: totalInput + totalCacheCreate + totalCacheRead,
    apiCalls: byRequest.size,
  }
}

/**
 * Estimate visible output tokens: characters of text and tool_use blocks the
 * model emitted, at 4 chars/token. Thinking blocks are excluded, so the gap
 * between API-reported output tokens and this estimate is the invisible
 * (reasoning) share of the session, plus this estimate's own error. Assistant
 * messages arrive as one JSONL line per content block (same requestId,
 * distinct uuid), so characters are summed across lines and only exact
 * duplicate uuids are dropped. Deduplicating by requestId would discard every
 * block of a request but the first. Covers main and subagent messages alike.
 */
export function calculateVisibleOutput(messages) {
  const seen = new Set()
  let chars = 0

  for (const msg of messages) {
    if (msg.message?.role !== 'assistant') continue
    const content = msg.message.content
    if (!Array.isArray(content)) continue
    if (msg.uuid) {
      if (seen.has(msg.uuid)) continue
      seen.add(msg.uuid)
    }
    for (const block of content) {
      if (block.type === 'text' && block.text) {
        chars += block.text.length
      } else if (block.type === 'tool_use') {
        chars += (block.name?.length ?? 0) + JSON.stringify(block.input ?? {}).length
      }
    }
  }

  return Math.ceil(chars / 4)
}

/**
 * API-reported output tokens across ALL messages, main and subagent alike, one
 * final usage per request. See finalUsageByRequest for why summing every line
 * would multiply each request by its block count.
 *
 * This is the correct denominator for calculateVisibleOutput: the legacy
 * tokens.output undercounts subagent work (it relies on Task-result usage
 * aggregates, absent whenever toolUseResult carries no agentId), and its
 * semantics are kept unchanged for longitudinal comparability.
 */
export function calculateDedupedOutput(messages) {
  let total = 0
  for (const { usage } of finalUsageByRequest(messages).values()) {
    total += outputOf(usage)
  }
  return total
}

// Returns { modelId: outputTokenCount } across all messages, one final usage per
// request. Covers both main and subagent messages since both carry message.model.
export function calculateOutputByModel(messages) {
  const result = {}

  for (const { usage, model } of finalUsageByRequest(messages).values()) {
    if (!model) continue
    result[model] = (result[model] || 0) + outputOf(usage)
  }

  return result
}
