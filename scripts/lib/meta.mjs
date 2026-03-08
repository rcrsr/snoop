/**
 * Meta tag scanning and parsing for custom transcript naming
 */

import * as fs from "fs";
import * as path from "path";

// Pattern: <snoop:meta key="value" .../>
const SNOOP_META_PATTERN = /<snoop:meta\s+([^>]+)\/>/g;

/**
 * Extract all key="value" attributes from a snoop:meta tag
 */
function parseMetaAttributes(attrString) {
  const result = {};
  const attrPattern = /(\w+)="([^"]*)"/g;
  let match;
  while ((match = attrPattern.exec(attrString)) !== null) {
    const [, name, value] = match;
    result[name] = value;
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
 * @returns {null | { file?: string, description?: string, tags?: string, [key: string]: string }}
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
 * Load context from .claude/snoop-context.json if it exists.
 * The "file" key is excluded (reserved for in-conversation meta tags only).
 * @param {string} projectDir - Project root directory
 * @returns {object} Context key-value pairs, or empty object
 */
export function loadSnoopContext(projectDir) {
  const contextPath = path.join(projectDir, ".claude", "snoop-context.json");
  if (!fs.existsSync(contextPath)) return {};

  try {
    const raw = fs.readFileSync(contextPath, "utf-8");
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
    const { file: _reserved, ...rest } = parsed;
    return rest;
  } catch {
    return {};
  }
}

// Attributes with special handling in buildMetaRecord
const SPECIAL_ATTRS = new Set(["file", "description", "tags"]);

// Built-in meta record keys that dynamic attributes must not overwrite
const BUILTIN_KEYS = new Set([
  "type", "transcriptId", "timing", "messageCount",
  "toolCount", "tools", "escInterrupts", "tokens", "subagents",
]);

// All reserved keys: special + built-in
const RESERVED_ATTRS = new Set([...SPECIAL_ATTRS, ...BUILTIN_KEYS]);

/**
 * Build meta record for transcript start
 * @param {object} stats - Transcript statistics
 * @param {object|null} metaInfo - Parsed meta tag info
 * @param {object} context - Context from snoop-context.json
 * @returns {object} Meta record to write as first JSONL line
 */
export function buildMetaRecord(stats, metaInfo, context = {}) {
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

  // Layer 1: context file values (excluding reserved attrs handled below)
  for (const [key, value] of Object.entries(context)) {
    if (!RESERVED_ATTRS.has(key)) {
      record[key] = value;
    }
  }

  // Layer 1: context file reserved attrs
  if (context.description) record.description = context.description;
  if (context.tags) {
    record.tags = (Array.isArray(context.tags) ? context.tags : String(context.tags).split(",").map((t) => t.trim()).filter((t) => t));
  }

  // Layer 2: dynamic meta tag attrs override context (excluding reserved)
  if (metaInfo) {
    for (const [key, value] of Object.entries(metaInfo)) {
      if (!RESERVED_ATTRS.has(key)) {
        record[key] = value;
      }
    }
  }

  // Layer 2: meta tag reserved attrs override context
  if (metaInfo?.description) {
    record.description = metaInfo.description;
  }
  if (metaInfo?.tags) {
    record.tags = metaInfo.tags.split(",").map((t) => t.trim()).filter((t) => t);
  }

  return record;
}
