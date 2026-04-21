# snoop

Claude Code plugin that captures run transcripts for debugging and review.

## Quick Reference

```bash
# Test locally
claude --plugin-dir /path/to/snoop

# User commands
/snoop:review              # Analyze last transcript
/snoop:review abc12345     # Analyze specific transcript
```

## Architecture

| Path | Purpose |
|------|---------|
| `scripts/capture-transcript.mjs` | Entry point + hook handlers |
| `scripts/lib/helpers.mjs` | File I/O, duration formatting |
| `scripts/lib/messages.mjs` | Message filtering, streamlining, analysis |
| `scripts/lib/tokens.mjs` | Token calculation from API-reported usage |
| `scripts/lib/meta.mjs` | Meta tag scanning and parsing |
| `hooks/hooks.json` | Binds `UserPromptSubmit`, `Stop`, and `StopFailure` events |
| `agents/transcript-reviewer.md` | Post-mortem analysis agent (haiku model) |
| `skills/review/SKILL.md` | `/snoop:review` entry point (Claude Code 2.1.3+) |

## Hook Behavior

| Event | Action |
|-------|--------|
| `UserPromptSubmit` | Detect ESC interrupt (pending `tool_use`), save partial transcript |
| `Stop` | Merge partials, write meta record + messages, update `latest` pointer, prune to 10 files |
| `StopFailure` | Same pipeline as `Stop`; fires instead of `Stop` on API errors (rate limit, 5xx, auth). Captured transcript has `0` output tokens, `0` tools, and no `lastAssistantPreview`. |

## Meta Tags

Add `<snoop:meta key="value"/>` anywhere in conversation. Three reserved attributes:
- **file**: Custom transcript path (relative to project root, always `.jsonl`)
- **description**: Free-text description stored in meta record
- **tags**: Comma-separated tags, stored as array

All other attributes pass through as raw strings to the meta record.
Multiple tags per conversation: last one wins (no merging). Custom paths skip `latest` pointer and pruning.

## Context File

Place `.claude/snoop-context.json` in the project root to set default meta values:

```json
{ "project": "snoop", "team": "platform", "tags": "plugin,debug" }
```

Merge order: context file values < snoop meta tag values.
Built-in keys (`type`, `transcriptId`, `timing`, `tokens`, `tools`, `messageCount`, `toolCount`, `escInterrupts`, `subagents`, `lastAssistantPreview`) cannot be overwritten by either source. `file` is only allowed in meta tags, not in the context file.

## When Editing

- **Status line format**: modify token/subagent/tool summary in `handleStop()`
- **Token calculation**: `lib/tokens.mjs` - all counts from API-reported usage
- **Message filtering**: `lib/messages.mjs` - `streamlineMessage()` controls captured fields
- **Meta tag parsing**: `lib/meta.mjs` - `scanForMetaTags()` extracts tag attributes
- **Subagent loading**: `loadSubagentMessages()` in main script

## Transcript Schema

JSONL with meta record first, then one message per line:

### Meta Record (first line)

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"meta"` |
| `transcriptId` | string | 8-char random ID |
| `timing` | object | `start`, `end` (ISO), `duration` (formatted) |
| `messageCount` | number | Total messages |
| `toolCount` | number | Total tool invocations |
| `tools` | array | Unique tool names used |
| `escInterrupts` | number | ESC interrupt count |
| `tokens` | object | Token usage breakdown |
| `subagents` | array | Subagent type names (if any) |
| `lastAssistantPreview` | string | Single-line preview of final assistant message, ≤200 chars (optional, Claude Code 2.1.101+) |
| `description` | string | From meta tag or context file (optional) |
| `tags` | array | From meta tag or context file (optional) |
| `*` | any | Dynamic attributes from meta tag or context file |

### Message Records

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `user`, `assistant`, or `interrupt` |
| `timestamp` | ISO string | Message timestamp |
| `uuid` | string | Message UUID |
| `requestId` | string | API request ID (for deduping streaming chunks) |
| `subagent` | string | Agent ID if from Task tool subagent |
| `message.content` | array | Blocks: `tool_use`, `tool_result`, `text`, `thinking` |
| `message.usage` | object | `input`, `output`, `cacheRead`, `cacheCreate`, `cache5m`, `cache1h` token counts |

Tool results truncated to 500 chars. Interrupt markers have `type: "interrupt"`.
