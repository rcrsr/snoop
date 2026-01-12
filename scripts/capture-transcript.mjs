#!/usr/bin/env node
/**
 * Dual-purpose hook for capturing run transcripts.
 * - UserPromptSubmit: Detects ESC interrupts, saves partial transcripts
 * - Stop: Merges partials, captures complete transcript
 */

import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

// -----------------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------------

async function readJsonLines(filePath) {
  const lines = [];
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    if (line.trim()) {
      try {
        lines.push(JSON.parse(line));
      } catch {
        // Skip malformed lines
      }
    }
  }
  return lines;
}

function isExternalUserPrompt(msg) {
  return (
    msg.type === "user" &&
    msg.userType === "external" &&
    typeof msg.message?.content === "string"
  );
}

function findLastUserPromptIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isExternalUserPrompt(messages[i])) {
      return i;
    }
  }
  return -1;
}

function hasToolUse(msg) {
  if (msg.type !== "assistant" || !Array.isArray(msg.message?.content)) {
    return false;
  }
  return msg.message.content.some((block) => block.type === "tool_use");
}

function cleanContentBlock(block) {
  switch (block.type) {
    case "thinking":
      return { type: block.type, thinking: block.thinking };
    case "tool_use":
      return { type: block.type, name: block.name, input: block.input };
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

function shouldSkipMessage(msg) {
  return msg.type === "file-history-snapshot";
}

function streamlineMessage(msg) {
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
      };
    }
  }
  // Capture toolUseResult for accurate subagent token counts
  if (msg.toolUseResult?.usage) {
    result.toolUseResult = {
      agentId: msg.toolUseResult.agentId,
      usage: {
        input: msg.toolUseResult.usage.input_tokens || 0,
        output: msg.toolUseResult.usage.output_tokens || 0,
        cacheCreate: msg.toolUseResult.usage.cache_creation_input_tokens || 0,
        cacheRead: msg.toolUseResult.usage.cache_read_input_tokens || 0,
      },
    };
  }
  return result;
}

function formatDuration(seconds) {
  if (seconds >= 60) {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}m ${secs}s`;
  }
  return `${seconds}s`;
}

function calculateDuration(messages) {
  const timestamps = messages
    .map((m) => m.timestamp)
    .filter((t) => !!t)
    .map((t) => new Date(t).getTime())
    .sort((a, b) => a - b);
  if (timestamps.length < 2) return "unknown";
  try {
    const seconds = Math.floor((timestamps[timestamps.length - 1] - timestamps[0]) / 1000);
    return formatDuration(seconds);
  } catch {
    return "unknown";
  }
}

function countToolUses(messages) {
  let count = 0;
  for (const msg of messages) {
    if ("message" in msg && Array.isArray(msg.message?.content)) {
      count += msg.message.content.filter((b) => b.type === "tool_use").length;
    }
  }
  return count;
}

function getUniqueTools(messages) {
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

function countEscInterrupts(messages) {
  return messages.filter((m) => m.type === "interrupt").length;
}

function getContentLength(block) {
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

function estimateTokensFromContent(messages) {
  // Estimate tokens by counting content characters / 4
  // Dedupe by uuid to avoid counting streaming chunks multiple times
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

function calculateTokenUsage(messages) {
  // Strategy:
  // 1. Input tokens: API-reported (reliable, includes system prompt + cache)
  // 2. Output tokens: toolUseResult.usage (accurate for subagents) + content estimate for main
  //
  // Why: Streaming output_tokens are unreliable (often 10x under-reported).
  // But toolUseResult contains accurate final counts for subagent tasks.
  //
  // Sort by timestamp: subagent messages may be appended at array end but have
  // earlier timestamps. Sorting ensures byRequest.set() captures final cumulative values.

  const sorted = [...messages].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });

  const byRequest = new Map();
  const toolUseResults = [];

  for (const msg of sorted) {
    if (msg.requestId && msg.message?.usage) {
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

  for (const usage of byRequest.values()) {
    totalInput += usage.input ?? usage.input_tokens ?? 0;
    totalCacheCreate += usage.cacheCreate ?? usage.cache_creation_input_tokens ?? 0;
    totalCacheRead += usage.cacheRead ?? usage.cache_read_input_tokens ?? 0;
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
    totalInput: totalInput + totalCacheCreate + totalCacheRead,
    apiCalls: byRequest.size,
  };
}

async function getSubagentFiles(transcriptPath) {
  // Transcript path: /path/to/session-id.jsonl
  // Subagents dir:   /path/to/session-id/subagents/
  const sessionDir = transcriptPath.replace(/\.jsonl$/, "");
  const subagentsDir = path.join(sessionDir, "subagents");

  if (!fs.existsSync(subagentsDir)) {
    return [];
  }

  return fs.readdirSync(subagentsDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => path.join(subagentsDir, f));
}

async function loadSubagentMessages(transcriptPath) {
  const subagentFiles = await getSubagentFiles(transcriptPath);
  const allMessages = [];

  for (const file of subagentFiles) {
    const agentId = path.basename(file, ".jsonl");
    const messages = await readJsonLines(file);

    for (const msg of messages) {
      if (shouldSkipMessage(msg)) continue;

      const streamlined = streamlineMessage(msg);
      streamlined.subagent = agentId;
      allMessages.push(streamlined);
    }
  }

  return allMessages;
}

// -----------------------------------------------------------------------------
// Hook Handlers
// -----------------------------------------------------------------------------

async function handleUserPromptSubmit(transcriptPath, partialFile) {
  const messages = await readJsonLines(transcriptPath);

  // Find the last assistant message
  let lastAssistant = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].type === "assistant") {
      lastAssistant = messages[i];
      break;
    }
  }

  // Check if it has pending tool_use (ESC interrupted)
  if (!lastAssistant || !hasToolUse(lastAssistant)) {
    return;
  }

  // Find the user prompt that started this flow
  const startIndex = findLastUserPromptIndex(messages);
  if (startIndex < 0) return;

  // Extract and streamline the partial flow
  const partial = messages
    .slice(startIndex)
    .filter((m) => !shouldSkipMessage(m))
    .map(streamlineMessage);

  // Create interrupt marker
  const marker = {
    type: "interrupt",
    marker: "═══════════════════ ⚠️ USER HIT ESC ═══════════════════",
    timestamp: new Date().toISOString(),
  };

  // Append to existing partial or create new
  let existingPartial = [];
  if (fs.existsSync(partialFile)) {
    const content = fs.readFileSync(partialFile, "utf-8");
    existingPartial = content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  }

  const combined = [...existingPartial, ...partial, marker];
  const output = combined.map((m) => JSON.stringify(m)).join("\n") + "\n";
  fs.writeFileSync(partialFile, output);
}

async function handleStop(transcriptPath, partialFile, outputDir) {
  const messages = await readJsonLines(transcriptPath);
  const startIndex = findLastUserPromptIndex(messages);

  if (startIndex < 0) {
    return { decision: "approve", systemMessage: "" };
  }

  // Generate output filename
  const randomId = Array.from({ length: 8 }, () =>
    "abcdefghijklmnopqrstuvwxyz0123456789".charAt(Math.floor(Math.random() * 36))
  ).join("");
  const outputFile = path.join(outputDir, `${randomId}.jsonl`);

  // Load any existing partial
  let combined = [];
  if (fs.existsSync(partialFile)) {
    const content = fs.readFileSync(partialFile, "utf-8");
    combined = content
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    fs.unlinkSync(partialFile);
  }

  // Add current segment
  const current = messages
    .slice(startIndex)
    .filter((m) => !shouldSkipMessage(m))
    .map(streamlineMessage);
  combined.push(...current);

  // Load and append subagent messages
  const subagentMessages = await loadSubagentMessages(transcriptPath);
  combined.push(...subagentMessages);

  // Write output
  const output = combined.map((m) => JSON.stringify(m)).join("\n") + "\n";
  fs.writeFileSync(outputFile, output);

  // Calculate stats (include subagent tokens)
  const msgCount = combined.length;
  const toolCount = countToolUses(combined);
  const uniqueTools = getUniqueTools(combined);
  const duration = calculateDuration(combined);
  const escCount = countEscInterrupts(combined);
  const tokens = calculateTokenUsage(combined);
  const interrupted = escCount > 0 ? `⚠️ ${escCount}x ESC | ` : "";
  const toolList = uniqueTools.join(", ") || "none";
  const tokenSummary = `${tokens.totalInput.toLocaleString()} / ${tokens.output.toLocaleString()} tokens (in / out)`;
  const subagentCount = new Set(subagentMessages.map((m) => m.subagent)).size;
  const subagentInfo = subagentCount > 0 ? ` | ${subagentCount} subagent${subagentCount > 1 ? "s" : ""}` : "";

  // Write latest pointer
  fs.writeFileSync(path.join(outputDir, "latest"), outputFile);

  // Cleanup old transcripts (keep last 10)
  const files = fs
    .readdirSync(outputDir)
    .filter((f) => f.endsWith(".jsonl") && !f.startsWith("."))
    .map((f) => ({ name: f, time: fs.statSync(path.join(outputDir, f)).mtime }))
    .sort((a, b) => b.time.getTime() - a.time.getTime());

  for (const file of files.slice(10)) {
    fs.unlinkSync(path.join(outputDir, file.name));
  }

  return {
    decision: "approve",
    systemMessage: `[Transcript captured: ${randomId} | ${interrupted}${msgCount} messages | ${toolCount} tool calls | ${tokenSummary} | duration: ${duration}${subagentInfo} | tools: ${toolList}]`,
  };
}

// -----------------------------------------------------------------------------
// Entry Point
// -----------------------------------------------------------------------------

async function main() {
  let inputData = "";
  for await (const chunk of process.stdin) {
    inputData += chunk;
  }

  const input = JSON.parse(inputData);
  const transcriptPath = input.transcript_path;
  const sessionId = input.session_id || "unknown";
  const hookEvent = input.hook_event_name || "Stop";

  if (!transcriptPath || !fs.existsSync(transcriptPath)) {
    process.exit(0);
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const outputDir = path.join(projectDir, ".claude", "transcripts");
  const partialFile = path.join(outputDir, `.partial_${sessionId}.jsonl`);

  fs.mkdirSync(outputDir, { recursive: true });

  // Ensure transcripts are not committed
  const gitignorePath = path.join(outputDir, ".gitignore");
  if (!fs.existsSync(gitignorePath)) {
    fs.writeFileSync(gitignorePath, "*\n");
  }

  if (hookEvent === "UserPromptSubmit") {
    await handleUserPromptSubmit(transcriptPath, partialFile);
    process.exit(0);
  }

  const result = await handleStop(transcriptPath, partialFile, outputDir);
  if (result.systemMessage) {
    console.log(JSON.stringify(result));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
