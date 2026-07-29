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
| `scripts/lib/context.mjs` | Context window occupancy and window-size inference |
| `scripts/lib/meta.mjs` | Meta tag scanning and parsing |
| `hooks/hooks.json` | Binds `UserPromptSubmit`, `Stop`, and `StopFailure` events |
| `agents/transcript-reviewer.md` | Post-mortem analysis agent (haiku model) |
| `skills/review/SKILL.md` | `/snoop:review` entry point (Claude Code 2.1.3+) |

## Hook Behavior

| Event | Action |
|-------|--------|
| `UserPromptSubmit` | Detect ESC interrupt (pending `tool_use`), save partial transcript |
| `Stop` | Wait for final assistant message, merge partials, write meta record + messages, update `latest` pointer, prune to 10 files |
| `StopFailure` | Same pipeline as `Stop` minus the wait; fires instead of `Stop` on API errors (rate limit, 5xx, auth). Captured transcript never has `lastAssistantPreview`. Turns that fail before any assistant output also show `0` output tokens and `0` tools; turns that fail after tool calls retain both. |

`Stop` fires before Claude Code flushes the turn's final assistant message to the session file. `readSettledTranscript()` polls for up to 1000 ms (50 ms interval) until the last conversation record is an assistant message with no pending `tool_use`, then returns whatever it has plus a `settled` flag. Without this the final API call's tokens, model, and text are lost. A line holding only a `tool_use` is mid-turn even though it is an assistant record, so `isFinalAssistantMessage()` rejects it. On timeout the meta record gets `incompleteCapture: true`.

`shouldSkipMessage()` is an allow-list: it keeps `user` and `assistant` records carrying a `message` body, plus the `interrupt` marker snoop writes. Claude Code interleaves at least twelve bookkeeping record types (`attachment`, `mode`, `permission-mode`, `last-prompt`, `ai-title`, `file-history-snapshot`, `summary`, `progress`, `system`, `queue-operation`, `pr-link`, `agent-name`) that carry no `message` body. Naming them one by one meant each new type silently inflated `messageCount` and corrupted `timing` until someone noticed.

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
Built-in keys (`type`, `transcriptId`, `timing`, `tokens`, `outputByModel`, `contextWindow`, `subagentContext`, `tools`, `messageCount`, `toolCount`, `escInterrupts`, `subagents`, `lastAssistantPreview`) cannot be overwritten by either source. `file` is only allowed in meta tags, not in the context file.

## When Editing

- **Status line format**: modify token/subagent/tool summary in `handleStop()`
- **Token calculation**: `lib/tokens.mjs` - all counts from API-reported usage. `finalUsageByRequest()` keeps one usage per `requestId`, the one with the largest `output_tokens`. A request's lines carry partial counts until the closing one, and line order is not reliably chronological, so never sort by timestamp and never sum per line.
- **Context occupancy**: `lib/context.mjs`. Distinct from `lib/tokens.mjs`: totals sum every request and only grow, occupancy is one request's prompt size and drops on compaction, so a session can bill 4M tokens while occupying 90k. `calculateContextWindow()` reads the whole session file, not `combined`, since a turn's flow cannot show an earlier peak or compaction. Current occupancy is the last main-chain assistant message in file order, matching Claude Code's own extractor and the settle contract; `peak` is a maximum and needs no ordering, so neither path sorts by timestamp. Rows whose occupancy is 0 are skipped: an `isApiErrorMessage` row carries a present-but-empty usage object, and 47 of 706 real sessions would otherwise have recorded a 0% reading for a turn whose window may have been nearly full. Context appears in the meta record and per-message fields only, never the status line — a live statusline already shows context there; snoop's job is capturing it for later review.
- **Window size inference**: not recoverable from `message.model` — a session running `opus[1m]` records plain `claude-opus-5`. Three signals, strongest first: occupancy above 200k (proof), `--model` in the `CLAUDE_PID` process argv, `settings.json` `model`. Only the first is proof, so `windowBasis` travels with the reading: consumers must treat `assumed` as an exact token count over a guessed 200k denominator. A `/model` switch mid-session is invisible to the latter two.
- **Message filtering**: `lib/messages.mjs` - `streamlineMessage()` controls captured fields
- **Meta tag parsing**: `lib/meta.mjs` - `scanForMetaTags()` extracts tag attributes
- **Subagent loading**: `loadSubagentMessages()` in main script. `findSubagentFiles()` recurses, since Task agents sit in `subagents/` but Workflow agents sit in `subagents/workflows/wf_<runId>/`. Names come from `agent-<id>.meta.json` sidecars via `loadAgentTypes()`, falling back to `buildAgentNameMap()`.

## Transcript Schema

JSONL with meta record first, then one message per line:

### Meta Record (first line)

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Always `"meta"` |
| `transcriptId` | string | 8-char random ID |
| `timing` | object | `start`, `end` (ISO), `duration` (formatted). A turn with one timestamped message closes against the hook's wall clock, so failed turns report elapsed time rather than `unknown` |
| `messageCount` | number | Total messages |
| `toolCount` | number | Total tool invocations |
| `tools` | array | Unique tool names used |
| `escInterrupts` | number | ESC interrupt count |
| `tokens` | object | Token usage breakdown. Output counts: `output` (legacy, undercounts subagents), `dedupedOutput` (main + subagent, deduped by `requestId`), `visibleOutput` (estimated readable text and tool calls, thinking excluded) |
| `outputByModel` | object | Per-model output token counts, deduped by `requestId` (optional) |
| `contextWindow` | object | Context occupancy at end of turn: `used`, `peak`, `size`, `windowBasis`, `usedPercentage`, `peakPercentage`, `model`, `compactThreshold`, `headroom`, `compactions` (optional; absent when no assistant usage exists yet) |
| `subagentContext` | array | Per-subagent occupancy: `agentId`, `peak`, `models`, `name` (optional) |
| `subagents` | array | Subagent type names (if any) |
| `lastAssistantPreview` | string | Single-line preview of final assistant message, ≤200 chars (optional, Claude Code 2.1.101+). Absent means the turn produced no final assistant message, which is how failures are detected. Empty string means it produced a blank one |
| `incompleteCapture` | boolean | Present and `true` only when the settle poll timed out. Token counts, `outputByModel`, and the preview are short |
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
| `message.model` | string | Model ID for this message (e.g. `claude-sonnet-4-6`). Varies per message when subagents use different models. |
| `message.content` | array | Blocks: `tool_use`, `tool_result`, `text`, `thinking` |
| `message.usage` | object | `input`, `output`, `cacheRead`, `cacheCreate`, `cache5m`, `cache1h` token counts, plus `context`: window occupancy at this request (`input + cacheCreate + cacheRead`). On a subagent row it is that agent's own window. Zero on API-error rows |

Tool result text truncated to 500 chars, for both the string and array forms of `tool_result.content`. Image payloads are elided to `<elided N chars>`, since a base64 screenshot runs past 500,000 chars. Interrupt markers have `type: "interrupt"`.
