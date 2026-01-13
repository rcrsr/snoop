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
| `scripts/capture-transcript.mjs` | Core hook handler. Routes via `hook_event_name` env var |
| `hooks/hooks.json` | Binds `UserPromptSubmit` and `Stop` events |
| `agents/transcript-reviewer.md` | Post-mortem analysis agent (haiku model) |
| `commands/review.md` | `/snoop:review` entry point |

## Hook Behavior

| Event | Action |
|-------|--------|
| `UserPromptSubmit` | Detect ESC interrupt (pending `tool_use`), save partial transcript |
| `Stop` | Merge partials, write final JSONL, update `latest` pointer, prune to 10 files |

## When Editing

- **Status line format**: modify `tokenSummary`, `subagentInfo`, `toolInfo` in `handleStop()`
- **Token calculation**: see `calculateTokenUsage()` - input from API, output estimated
- **Message filtering**: `streamlineMessage()` controls what fields are captured
- **Subagent loading**: `loadSubagentMessages()` reads from Claude Code's internal logs

## Transcript Schema

JSONL with one message per line:

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
