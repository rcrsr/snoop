/**
 * Meta tag scanning and parsing for custom transcript naming
 */

import * as path from "path";

// Pattern: <snoop:meta file="..." description="..." tags="..."/>
const SNOOP_META_PATTERN = /<snoop:meta\s+([^>]+)\/>/g;

/**
 * Extract attributes from a snoop:meta tag attribute string
 * Parses: file="value" description="value" tags="value"
 */
function parseMetaAttributes(attrString) {
  const result = {};
  const attrPattern = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = attrPattern.exec(attrString)) !== null) {
    const [, name, value] = match;
    if (name === "file" || name === "description" || name === "tags") {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Unescape JSON string escape sequences
 * Handles: \" -> ", \\ -> \, \n -> newline, \t -> tab
 */
function unescapeJsonString(str) {
  return str
    .replace(/\\"/g, '"')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\\\/g, '\\');
}

/**
 * Extract text content from a message for scanning
 */
function extractTextContent(msg) {
  const texts = [];

  if (!msg.message?.content) return texts;

  const content = msg.message.content;

  // User messages with string content
  if (typeof content === "string") {
    texts.push(content);
    return texts;
  }

  // Array content (both user and assistant)
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === "text" && block.text) {
        // Unescape in case LLM shows JSON output containing the meta tag
        texts.push(unescapeJsonString(block.text));
      }
      if (block.type === "tool_result" && typeof block.content === "string") {
        // Unescape JSON strings so meta tags with escaped quotes can be matched
        texts.push(unescapeJsonString(block.content));
      }
    }
  }

  return texts;
}

/**
 * Scan all message content for snoop:meta tags
 * Returns the last occurrence (last wins)
 * @returns {null | { file?: string, description?: string, tags?: string }}
 */
export function scanForMetaTags(messages) {
  let lastMeta = null;

  for (const msg of messages) {
    const texts = extractTextContent(msg);
    for (const text of texts) {
      // Reset regex state for each text block
      SNOOP_META_PATTERN.lastIndex = 0;
      let match;
      while ((match = SNOOP_META_PATTERN.exec(text)) !== null) {
        const attrs = parseMetaAttributes(match[1]);
        if (Object.keys(attrs).length > 0) {
          lastMeta = attrs;
        }
      }
    }
  }

  return lastMeta;
}

/**
 * Normalize and validate the file path
 * - Support subdirectories
 * - Always use .jsonl extension (replace any existing extension)
 * - Sanitize: reject absolute paths and path traversal
 * @returns {string} Normalized relative path with .jsonl extension
 * @throws {Error} If path is invalid
 */
export function normalizeFilePath(filePath) {
  // Reject absolute paths
  if (path.isAbsolute(filePath)) {
    throw new Error(`Invalid meta file path: absolute paths not allowed (${filePath})`);
  }

  // Normalize and check for path traversal
  const normalized = path.normalize(filePath);
  if (normalized.startsWith("..") || normalized.includes("/../") || normalized.includes("\\..\\")) {
    throw new Error(`Invalid meta file path: path traversal not allowed (${filePath})`);
  }

  // Always use .jsonl extension - strip any existing extension and add .jsonl
  const ext = path.extname(normalized);
  const basePath = ext ? normalized.slice(0, -ext.length) : normalized;
  return basePath + ".jsonl";
}

/**
 * Build meta record for transcript start
 * @param {object} stats - Transcript statistics
 * @param {object|null} metaInfo - Parsed meta tag info
 * @returns {object} Meta record to write as first JSONL line
 */
export function buildMetaRecord(stats, metaInfo) {
  const record = {
    type: "meta",
    transcriptId: stats.transcriptId,
    timing: {
      start: stats.timing.start,
      end: stats.timing.end,
      duration: stats.timing.durationFormatted,
    },
    messageCount: stats.messageCount,
    toolCount: stats.toolCount,
    tools: stats.tools,
    escInterrupts: stats.escInterrupts,
    tokens: stats.tokens,
  };

  if (stats.subagents && stats.subagents.length > 0) {
    record.subagents = stats.subagents;
  }

  if (metaInfo?.description) {
    record.description = metaInfo.description;
  }

  if (metaInfo?.tags) {
    record.tags = metaInfo.tags.split(",").map((t) => t.trim()).filter((t) => t);
  }

  return record;
}
