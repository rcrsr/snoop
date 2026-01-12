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
  const timestamps = messages.map((m) => m.timestamp).filter((t) => !!t);
  if (timestamps.length < 2) return "unknown";
  try {
    const first = new Date(timestamps[0]).getTime();
    const last = new Date(timestamps[timestamps.length - 1]).getTime();
    const seconds = Math.floor((last - first) / 1000);
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

function calculateTokenUsage(messages) {
  // Group by requestId to avoid double-counting streaming chunks
  // Take the last message per requestId (has final token counts)
  const byRequest = new Map();
  for (const msg of messages) {
    if (msg.requestId && msg.message?.usage) {
      byRequest.set(msg.requestId, msg.message.usage);
    }
  }

  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheCreate = 0;
  let totalCacheRead = 0;

  for (const usage of byRequest.values()) {
    totalInput += usage.input || 0;
    totalOutput += usage.output || 0;
    totalCacheCreate += usage.cacheCreate || 0;
    totalCacheRead += usage.cacheRead || 0;
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

  // Write output
  const output = combined.map((m) => JSON.stringify(m)).join("\n") + "\n";
  fs.writeFileSync(outputFile, output);

  // Calculate stats
  const msgCount = combined.length;
  const toolCount = countToolUses(combined);
  const uniqueTools = getUniqueTools(combined);
  const duration = calculateDuration(combined);
  const escCount = countEscInterrupts(combined);
  const tokens = calculateTokenUsage(combined);
  const interrupted = escCount > 0 ? `⚠️ ${escCount}x ESC | ` : "";
  const toolList = uniqueTools.join(", ") || "none";
  const tokenSummary = `${tokens.totalInput.toLocaleString()} / ${tokens.output.toLocaleString()} tokens (in / out)`;

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
    systemMessage: `[Transcript captured: ${randomId} | ${interrupted}${msgCount} messages | ${toolCount} tool calls | ${tokenSummary} | duration: ${duration} | tools: ${toolList}]`,
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
