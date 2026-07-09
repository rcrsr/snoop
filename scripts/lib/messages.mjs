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

const MAX_TOOL_RESULT_CHARS = 500;

function truncateText(text) {
  return text.length > MAX_TOOL_RESULT_CHARS
    ? text.slice(0, MAX_TOOL_RESULT_CHARS) + "..."
    : text;
}

/**
 * Strip the payload from a base64 image block, keeping its shape. A base64
 * screenshot runs to hundreds of kilobytes and carries no value in a
 * transcript. Any other source shape (a url reference, say) is small and is
 * returned untouched, since rebuilding it would discard fields we do not know
 * about.
 */
function elideImage(block) {
  const data = block.source?.data;
  if (typeof data !== "string") return block;

  return {
    ...block,
    source: { ...block.source, data: `<elided ${data.length} chars>` },
  };
}

/**
 * Tool results arrive with content as either a string or an array of blocks.
 * The array form carries text and images, and images may be base64 payloads
 * over 500,000 chars. Both forms are bounded here.
 */
function cleanToolResultContent(content) {
  if (typeof content === "string") return truncateText(content);
  if (!Array.isArray(content)) return content;

  return content.map((block) => {
    if (block.type === "text" && typeof block.text === "string") {
      return { ...block, text: truncateText(block.text) };
    }
    if (block.type === "image") return elideImage(block);
    return block;
  });
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
    case "tool_result":
      return {
        type: block.type,
        tool_use_id: block.tool_use_id,
        content: cleanToolResultContent(block.content),
      };
    case "image":
      return elideImage(block);
    default:
      return block;
  }
}

/**
 * Check if a raw session record is a conversation message (user or assistant
 * turn carrying a message body), as opposed to a metadata record.
 */
export function isConversationMessage(msg) {
  return (msg.type === "user" || msg.type === "assistant") && !!msg.message;
}

/**
 * Check if message should be skipped from transcript.
 *
 * Claude Code interleaves a dozen bookkeeping record types with the real
 * messages: attachment, mode, permission-mode, last-prompt, ai-title, system,
 * queue-operation, pr-link, agent-name, file-history-snapshot, summary,
 * progress. None carries a message body. Naming them individually meant every
 * record type Claude Code added silently inflated messageCount and corrupted
 * timing until someone noticed, so keep what we understand instead: the two
 * conversation types, plus the interrupt marker snoop writes itself.
 */
export function shouldSkipMessage(msg) {
  return !isConversationMessage(msg) && msg.type !== "interrupt";
}

/**
 * Check if a record is a turn's settled final assistant message: an assistant
 * message with no tool_use block still awaiting a result. A line carrying only
 * a tool_use is mid-turn, even though it is an assistant record.
 */
export function isFinalAssistantMessage(msg) {
  return msg?.type === "assistant" && !!msg.message && !hasToolUse(msg);
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
    if (msg.message.model) {
      result.message.model = msg.message.model;
    }
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

  // First pass: collect Agent/Task tool_use blocks
  for (const msg of messages) {
    if (msg.type !== "assistant" || !Array.isArray(msg.message?.content)) continue;
    for (const block of msg.message.content) {
      if (block.type === "tool_use" && (block.name === "Agent" || block.name === "Task") && block.input?.subagent_type) {
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
