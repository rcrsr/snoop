#!/usr/bin/env node
/**
 * Dual-purpose hook for capturing run transcripts.
 * - UserPromptSubmit: Detects ESC interrupts, saves partial transcripts
 * - Stop: Merges partials, captures complete transcript with meta record
 */

import * as fs from "fs";
import * as path from "path";

import { readJsonLines, calculateTiming } from "./lib/helpers.mjs";
import {
  findLastUserPromptIndex,
  hasToolUse,
  shouldSkipMessage,
  streamlineMessage,
  countToolUses,
  getUniqueTools,
  countEscInterrupts,
  buildAgentNameMap,
} from "./lib/messages.mjs";
import { calculateTokenUsage, calculateOutputByModel } from "./lib/tokens.mjs";
import { scanForMetaTags, normalizeFilePath, buildMetaRecord, loadSnoopContext } from "./lib/meta.mjs";

// -----------------------------------------------------------------------------
// Subagent Loading
// -----------------------------------------------------------------------------

async function getSubagentFiles(transcriptPath) {
  // Transcript path: /path/to/session-id.jsonl
  // Subagents dir:   /path/to/session-id/subagents/
  const sessionDir = transcriptPath.replace(/\.jsonl$/, "");
  const subagentsDir = path.join(sessionDir, "subagents");

  if (!fs.existsSync(subagentsDir)) {
    return [];
  }

  return fs
    .readdirSync(subagentsDir)
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

/**
 * Truncate and normalize the Stop hook's last_assistant_message for the meta
 * record. Collapses internal whitespace into single spaces so the preview
 * stays on one line, then trims to maxChars characters.
 */
function modelShortcode(modelId) {
  const m = modelId.match(/claude-(sonnet|opus|haiku)-(\d+)-(\d+)/);
  if (!m) return modelId;
  return { sonnet: "s", opus: "o", haiku: "h" }[m[1]] + m[2] + m[3];
}

function buildLastAssistantPreview(raw, maxChars = 200) {
  if (typeof raw !== "string" || !raw) return null;
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return null;
  return collapsed.length <= maxChars ? collapsed : collapsed.slice(0, maxChars - 1) + "…";
}

async function handleStop(transcriptPath, partialFile, outputDir, projectDir, lastAssistantMessage) {
  const messages = await readJsonLines(transcriptPath);
  const startIndex = findLastUserPromptIndex(messages);

  if (startIndex < 0) {
    return { decision: "approve", systemMessage: "" };
  }

  // Generate transcript ID
  const transcriptId = Array.from({ length: 8 }, () =>
    "abcdefghijklmnopqrstuvwxyz0123456789".charAt(Math.floor(Math.random() * 36))
  ).join("");

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

  // Load and append subagent messages (only from current turn)
  const turnStart = current[0]?.timestamp ? new Date(current[0].timestamp).getTime() : 0;
  const subagentMessages = (await loadSubagentMessages(transcriptPath)).filter((m) => {
    if (!m.timestamp || !turnStart) return true;
    return new Date(m.timestamp).getTime() >= turnStart;
  });
  combined.push(...subagentMessages);

  // Scan for meta tags (last one wins) and load context file
  const metaInfo = scanForMetaTags(combined);
  const snoopContext = loadSnoopContext(projectDir);

  // Determine output path
  let outputFile;
  let isCustomPath = false;
  if (metaInfo?.file) {
    try {
      const normalizedPath = normalizeFilePath(metaInfo.file);
      // Custom paths are relative to project root, not transcripts dir
      outputFile = path.join(projectDir, normalizedPath);
      isCustomPath = true;

      // Create subdirectories if needed
      const outputFileDir = path.dirname(outputFile);
      fs.mkdirSync(outputFileDir, { recursive: true });
    } catch (err) {
      // Invalid path, fall back to default
      console.error(`Warning: ${err.message}. Using default path.`);
      outputFile = path.join(outputDir, `${transcriptId}.jsonl`);
    }
  } else {
    outputFile = path.join(outputDir, `${transcriptId}.jsonl`);
  }

  // Calculate stats
  const timing = calculateTiming(combined);
  const msgCount = combined.length;
  const toolCount = countToolUses(combined);
  const uniqueTools = getUniqueTools(combined);
  const escCount = countEscInterrupts(combined);
  const tokens = calculateTokenUsage(combined);
  const outputByModel = calculateOutputByModel(combined);
  const subagentIds = Array.from(new Set(subagentMessages.map((m) => m.subagent))).sort();
  const agentNameMap = buildAgentNameMap(combined);
  const subagentNames = [...new Set(subagentIds.map((id) => agentNameMap.get(id) || id))].sort();

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
      subagents: subagentNames,
      lastAssistantPreview: buildLastAssistantPreview(lastAssistantMessage),
    },
    metaInfo,
    snoopContext
  );

  // Write output (meta record first, then messages)
  const outputLines = [JSON.stringify(metaRecord), ...combined.map((m) => JSON.stringify(m))];
  fs.writeFileSync(outputFile, outputLines.join("\n") + "\n");

  // Only update latest pointer for default-named transcripts
  if (!isCustomPath) {
    fs.writeFileSync(path.join(outputDir, "latest"), outputFile);
  }

  // Cleanup old transcripts (keep last 10) - only prune files directly in outputDir
  if (!isCustomPath) {
    const files = fs
      .readdirSync(outputDir)
      .filter((f) => {
        const fullPath = path.join(outputDir, f);
        return (
          f.endsWith(".jsonl") &&
          !f.startsWith(".") &&
          fs.statSync(fullPath).isFile() // Not a directory
        );
      })
      .map((f) => ({ name: f, time: fs.statSync(path.join(outputDir, f)).mtime }))
      .sort((a, b) => b.time.getTime() - a.time.getTime());

    for (const file of files.slice(10)) {
      fs.unlinkSync(path.join(outputDir, file.name));
    }
  }

  // Build status line
  const interrupted = escCount > 0 ? `⚠️ ${escCount}x ESC | ` : "";
  const toolList = uniqueTools.join(", ");

  // Build token breakdown, skipping 0 values
  const breakdownParts = [];
  if (tokens.input > 0) breakdownParts.push(`${tokens.input.toLocaleString()} p`);
  if (tokens.cache5m > 0) breakdownParts.push(`${tokens.cache5m.toLocaleString()} cw5m`);
  if (tokens.cache1h > 0) breakdownParts.push(`${tokens.cache1h.toLocaleString()} cw1h`);
  if (tokens.cacheRead > 0) breakdownParts.push(`${tokens.cacheRead.toLocaleString()} cr`);
  const cacheEfficiency = tokens.totalInput > 0 ? Math.round((tokens.cacheRead / tokens.totalInput) * 100) : 0;
  if (cacheEfficiency > 0) breakdownParts.push(`${cacheEfficiency}% ce`);
  const breakdown = breakdownParts.length > 0 ? ` (${breakdownParts.join(" / ")})` : "";
  const modelEntries = Object.entries(outputByModel);
  let modelBreakdown = "";
  if (modelEntries.length > 1) {
    const total = modelEntries.reduce((s, [, n]) => s + n, 0);
    modelBreakdown = " | " + modelEntries
      .sort((a, b) => b[1] - a[1])
      .map(([model, n]) => `${Math.round((n / total) * 100)}% ${modelShortcode(model)}`)
      .join(" / ");
  }
  const tokenSummary = `${tokens.totalInput.toLocaleString()} in${breakdown} | ${tokens.output.toLocaleString()} out${modelBreakdown}`;

  const subagentCount = subagentIds.length;
  const subagentInfo = subagentCount > 0 ? ` | ${subagentCount} si (${subagentNames.join(", ")})` : "";
  const toolInfo = toolCount > 0 ? ` | ${toolCount} ti (${toolList})` : "";

  // Include custom path indicator if applicable
  const pathIndicator = isCustomPath ? ` → ${metaInfo.file}` : "";

  return {
    decision: "approve",
    systemMessage: `[snoop] ${transcriptId}${pathIndicator} | ${timing.durationFormatted} | ${interrupted}${msgCount} msgs | ${tokenSummary}${subagentInfo}${toolInfo}`,
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

  const result = await handleStop(transcriptPath, partialFile, outputDir, projectDir, input.last_assistant_message);
  if (result.systemMessage) {
    console.log(JSON.stringify(result));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
