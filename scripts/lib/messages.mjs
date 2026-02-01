/**
 * Message filtering, streamlining, and analysis
 */

/**
 * Check if message is an external user prompt
 */
export function isExternalUserPrompt(msg) {
  return (
    msg.type === "user" &&
    msg.userType === "external" &&
    typeof msg.message?.content === "string"
  );
}

/**
 * Find index of last external user prompt
 */
export function findLastUserPromptIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isExternalUserPrompt(messages[i])) {
      return i;
    }
  }
  return -1;
}

/**
 * Check if assistant message has tool_use blocks
 */
export function hasToolUse(msg) {
  if (msg.type !== "assistant" || !Array.isArray(msg.message?.content)) {
    return false;
  }
  return msg.message.content.some((block) => block.type === "tool_use");
}

/**
 * Clean a content block for transcript storage
 */
export function cleanContentBlock(block) {
  switch (block.type) {
    case "thinking":
      return { type: block.type, thinking: block.thinking };
    case "tool_use":
      return { type: block.type, id: block.id, name: block.name, input: block.input };
    case "tool_result": {
      let content = block.content;
      if (typeof content === "string" && content.length > 500) {
        content = content.slice(0, 500) + "...";
      }
      return { type: block.type, tool_use_id: block.tool_use_id, content };
    }
    default:
      return block;
  }
}

/**
 * Check if message should be skipped from transcript
 */
export function shouldSkipMessage(msg) {
  return msg.type === "file-history-snapshot" || msg.type === "summary";
}

/**
 * Convert raw message to streamlined transcript format
 */
export function streamlineMessage(msg) {
  const result = {
    type: msg.type,
    timestamp: msg.timestamp,
    uuid: msg.uuid,
    parentUuid: msg.parentUuid,
  };
  if (msg.requestId) {
    result.requestId = msg.requestId;
  }
  if (msg.message) {
    const content = msg.message.content;
    result.message = {
      role: msg.message.role,
      content: Array.isArray(content) ? content.map(cleanContentBlock) : content,
    };
    if (msg.message.usage) {
      result.message.usage = {
        input: msg.message.usage.input_tokens || 0,
        output: msg.message.usage.output_tokens || 0,
        cacheCreate: msg.message.usage.cache_creation_input_tokens || 0,
        cacheRead: msg.message.usage.cache_read_input_tokens || 0,
        cache5m: msg.message.usage.cache_creation?.ephemeral_5m_input_tokens || 0,
        cache1h: msg.message.usage.cache_creation?.ephemeral_1h_input_tokens || 0,
      };
    }
  }
  // Capture toolUseResult for subagent token counts and name mapping
  if (msg.toolUseResult?.agentId) {
    result.toolUseResult = {
      agentId: msg.toolUseResult.agentId,
    };
    if (msg.toolUseResult.usage) {
      result.toolUseResult.usage = {
        input: msg.toolUseResult.usage.input_tokens || 0,
        output: msg.toolUseResult.usage.output_tokens || 0,
        cacheCreate: msg.toolUseResult.usage.cache_creation_input_tokens || 0,
        cacheRead: msg.toolUseResult.usage.cache_read_input_tokens || 0,
        cache5m: msg.toolUseResult.usage.cache_creation?.ephemeral_5m_input_tokens || 0,
        cache1h: msg.toolUseResult.usage.cache_creation?.ephemeral_1h_input_tokens || 0,
      };
    }
  }
  return result;
}

/**
 * Count tool_use blocks in messages
 */
export function countToolUses(messages) {
  let count = 0;
  for (const msg of messages) {
    if ("message" in msg && Array.isArray(msg.message?.content)) {
      count += msg.message.content.filter((b) => b.type === "tool_use").length;
    }
  }
  return count;
}

/**
 * Get sorted list of unique tool names used
 */
export function getUniqueTools(messages) {
  const tools = new Set();
  for (const msg of messages) {
    if ("message" in msg && Array.isArray(msg.message?.content)) {
      for (const block of msg.message.content) {
        if (block.type === "tool_use" && block.name) {
          tools.add(block.name);
        }
      }
    }
  }
  return Array.from(tools).sort();
}

/**
 * Count ESC interrupt markers
 */
export function countEscInterrupts(messages) {
  return messages.filter((m) => m.type === "interrupt").length;
}

/**
 * Build map of agentId -> subagent_type by linking Task tool_use to toolUseResult
 */
export function buildAgentNameMap(messages) {
  const toolUseTypes = new Map(); // tool_use.id -> subagent_type
  const agentNames = new Map(); // agentId -> subagent_type

  // First pass: collect Task tool_use blocks
  for (const msg of messages) {
    if (msg.type !== "assistant" || !Array.isArray(msg.message?.content)) continue;
    for (const block of msg.message.content) {
      if (block.type === "tool_use" && block.name === "Task" && block.input?.subagent_type) {
        toolUseTypes.set(block.id, block.input.subagent_type);
      }
    }
  }

  // Second pass: match toolUseResult.agentId to tool_result.tool_use_id
  for (const msg of messages) {
    if (msg.type !== "user" || !msg.toolUseResult?.agentId) continue;
    const agentId = msg.toolUseResult.agentId;
    if (!Array.isArray(msg.message?.content)) continue;

    // Find the Task tool_result in this message
    for (const block of msg.message.content) {
      if (block.type === "tool_result" && toolUseTypes.has(block.tool_use_id)) {
        agentNames.set("agent-" + agentId, toolUseTypes.get(block.tool_use_id));
        break;
      }
    }
  }

  return agentNames;
}
