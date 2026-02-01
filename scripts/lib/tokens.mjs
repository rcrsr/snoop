/**
 * Token calculation and estimation
 */

/**
 * Get character length of a content block
 */
export function getContentLength(block) {
  if (!block) return 0;
  switch (block.type) {
    case "thinking":
      return (block.thinking || "").length;
    case "text":
      return (block.text || "").length;
    case "tool_use":
      return JSON.stringify(block.input || {}).length;
    case "tool_result":
      return (typeof block.content === "string" ? block.content : JSON.stringify(block.content || "")).length;
    default:
      return 0;
  }
}

/**
 * Estimate tokens by counting content characters / 4
 * Dedupes by uuid to avoid counting streaming chunks multiple times
 */
export function estimateTokensFromContent(messages) {
  const seen = new Set();
  let inputChars = 0;
  let outputChars = 0;

  for (const msg of messages) {
    if (msg.uuid && seen.has(msg.uuid)) continue;
    if (msg.uuid) seen.add(msg.uuid);

    const content = msg.message?.content;
    if (!content) continue;

    if (msg.type === "assistant") {
      // Output: thinking, text, tool_use from assistant
      if (Array.isArray(content)) {
        for (const block of content) {
          if (["thinking", "text", "tool_use"].includes(block.type)) {
            outputChars += getContentLength(block);
          }
        }
      }
    } else if (msg.type === "user") {
      // Input: user prompt text and tool_result blocks
      if (typeof content === "string") {
        inputChars += content.length;
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_result") {
            inputChars += getContentLength(block);
          } else if (block.type === "text") {
            inputChars += (block.text || "").length;
          }
        }
      }
    }
  }

  return {
    input: Math.ceil(inputChars / 4),
    output: Math.ceil(outputChars / 4),
  };
}

/**
 * Calculate token usage from messages
 *
 * Strategy:
 * 1. Input tokens: API-reported (reliable, includes system prompt + cache)
 * 2. Output tokens: toolUseResult.usage (accurate for subagents) + content estimate for main
 *
 * Why: Streaming output_tokens are unreliable (often 10x under-reported).
 * But toolUseResult contains accurate final counts for subagent tasks.
 *
 * Sort by timestamp: subagent messages may be appended at array end but have
 * earlier timestamps. Sorting ensures byRequest.set() captures final cumulative values.
 */
export function calculateTokenUsage(messages) {
  const sorted = [...messages].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });

  const byRequest = new Map();
  const toolUseResults = [];

  for (const msg of sorted) {
    // Main conversation only - subagent tokens come from toolUseResult
    if (msg.requestId && msg.message?.usage && !msg.subagent) {
      byRequest.set(msg.requestId, msg.message.usage);
    }
    // Collect toolUseResult from user messages (Task tool completions)
    if (msg.toolUseResult?.usage) {
      toolUseResults.push(msg.toolUseResult.usage);
    }
  }

  let totalInput = 0;
  let totalCacheCreate = 0;
  let totalCacheRead = 0;
  let totalCache5m = 0;
  let totalCache1h = 0;

  for (const usage of byRequest.values()) {
    totalInput += usage.input ?? usage.input_tokens ?? 0;
    totalCacheCreate += usage.cacheCreate ?? usage.cache_creation_input_tokens ?? 0;
    totalCacheRead += usage.cacheRead ?? usage.cache_read_input_tokens ?? 0;
    totalCache5m += usage.cache5m ?? usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
    totalCache1h += usage.cache1h ?? usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  }

  // Output tokens: prefer toolUseResult (accurate), fallback to content estimate
  let totalOutput = 0;
  if (toolUseResults.length > 0) {
    // Use accurate counts from toolUseResult
    for (const usage of toolUseResults) {
      totalOutput += usage.output ?? usage.output_tokens ?? 0;
      // Also add subagent input/cache to totals
      totalInput += usage.input ?? usage.input_tokens ?? 0;
      totalCacheCreate += usage.cacheCreate ?? usage.cache_creation_input_tokens ?? 0;
      totalCacheRead += usage.cacheRead ?? usage.cache_read_input_tokens ?? 0;
      totalCache5m += usage.cache5m ?? usage.cache_creation?.ephemeral_5m_input_tokens ?? 0;
      totalCache1h += usage.cache1h ?? usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
    }
    // Add content estimate for main conversation (non-subagent messages)
    const mainMessages = messages.filter((m) => !m.subagent);
    const mainEstimate = estimateTokensFromContent(mainMessages);
    totalOutput += mainEstimate.output;
  } else {
    // No subagents, use content estimate for everything
    const estimated = estimateTokensFromContent(messages);
    totalOutput = estimated.output;
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
  };
}
