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
  };
}

export function calculateTokenUsage(messages) {
  const sorted = [...messages].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });

  const byRequest = new Map();
  const subagentUsages = [];

  for (const msg of sorted) {
    if (msg.requestId && msg.message?.usage && !msg.subagent) {
      byRequest.set(msg.requestId, msg.message.usage);
    }
    if (msg.toolUseResult?.usage) {
      subagentUsages.push(msg.toolUseResult.usage);
    }
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheCreate = 0;
  let totalCacheRead = 0;
  let totalCache5m = 0;
  let totalCache1h = 0;

  for (const usage of byRequest.values()) {
    const u = addUsage(usage);
    totalInput += u.input;
    totalOutput += u.output;
    totalCacheCreate += u.cacheCreate;
    totalCacheRead += u.cacheRead;
    totalCache5m += u.cache5m;
    totalCache1h += u.cache1h;
  }

  for (const usage of subagentUsages) {
    const u = addUsage(usage);
    totalInput += u.input;
    totalOutput += u.output;
    totalCacheCreate += u.cacheCreate;
    totalCacheRead += u.cacheRead;
    totalCache5m += u.cache5m;
    totalCache1h += u.cache1h;
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
