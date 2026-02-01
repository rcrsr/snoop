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
| `scripts/lib/tokens.mjs` | Token calculation and estimation |
| `scripts/lib/meta.mjs` | Meta tag scanning and parsing |
| `hooks/hooks.json` | Binds `UserPromptSubmit` and `Stop` events |
| `agents/transcript-reviewer.md` | Post-mortem analysis agent (haiku model) |
| `commands/review.md` | `/snoop:review` entry point |

## Hook Behavior

| Event | Action |
|-------|--------|
| `UserPromptSubmit` | Detect ESC interrupt (pending `tool_use`), save partial transcript |
| `Stop` | Merge partials, write meta record + messages, update `latest` pointer, prune to 10 files |

## Meta Tags

Add `<snoop:meta file="..." description="..." tags="..."/>` anywhere in conversation to:
- **file**: Custom transcript path (relative to project root, auto-appends `.jsonl` if no extension)
- **description**: Free-text description stored in meta record
- **tags**: Comma-separated tags for categorization

Multiple tags: last one wins. Custom paths skip `latest` pointer and pruning.

## When Editing

- **Status line format**: modify token/subagent/tool summary in `handleStop()`
- **Token calculation**: `lib/tokens.mjs` - input from API, output estimated
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
| `description` | string | From meta tag (optional) |
| `tags` | array | From meta tag (optional) |

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
