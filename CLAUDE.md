# snoop

Claude Code plugin that captures run transcripts for debugging and review.

## Quick Reference

```bash
# Test locally
claude --plugin-dir /path/to/snoop

# Run tests
node --test test/*.test.mjs

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
| `scripts/lib/context.mjs` | Context window occupancy and per-model window sizes |
| `scripts/lib/meta.mjs` | Meta tag scanning and parsing |
| `hooks/hooks.json` | Binds `UserPromptSubmit`, `Stop`, `StopFailure`, and `SessionEnd` events |
| `agents/transcript-reviewer.md` | Post-mortem analysis agent (sonnet model) |
| `skills/review/SKILL.md` | `/snoop:review` entry point (Claude Code 2.1.3+) |

## Hook Behavior

| Event | Action |
|-------|--------|
| `UserPromptSubmit` | Detect ESC interrupt (pending `tool_use` or `[Request interrupted by user` marker), save partial transcript |
| `Stop` | Wait for final assistant message, merge partials, write meta record + messages, update `latest` pointer, prune to 10 files |
| `StopFailure` | Same pipeline as `Stop` minus the wait; fires instead of `Stop` on API errors (rate limit, 5xx, auth). Captured transcript never has `lastAssistantPreview`. Turns that fail before any assistant output also show `0` output tokens and `0` tools; turns that fail after tool calls retain both. |
| `SessionEnd` | Flush subagent messages written since the last snoop capture started (`previousCaptureStart()` over the whole file). Writes nothing when none exist, or when the session has no earlier capture to bound from. No partial merge, no preview; `timing` spans the agent messages. The meta record carries `trailingCapture: true`. A resumed session's next `Stop` re-captures the same messages, since SessionEnd leaves no `stop_hook_summary` behind |

`Stop` fires before Claude Code flushes the turn's final assistant message to the session file. `readSettledTranscript()` polls for up to 1000 ms (50 ms interval) until the last conversation record is an assistant message with no pending `tool_use`, then returns whatever it has plus a `settled` flag. Without this the final API call's tokens, model, and text are lost. A line holding only a `tool_use` is mid-turn even though it is an assistant record, so `isFinalAssistantMessage()` rejects it. On timeout the meta record gets `incompleteCapture: true`.

`shouldSkipMessage()` is an allow-list: it keeps `user` and `assistant` records carrying a `message` body, plus the `interrupt` marker snoop writes. Claude Code interleaves at least sixteen bookkeeping record types (`attachment`, `mode`, `permission-mode`, `last-prompt`, `ai-title`, `file-history-snapshot`, `file-history-delta`, `summary`, `progress`, `system`, `queue-operation`, `pr-link`, `agent-name`, `atis-latch`, `cost-state`, `fork-context-ref`) that carry no `message` body. Naming them one by one meant each new type silently inflated `messageCount` and corrupted `timing` until someone noticed.

## Meta Tags

Add `<snoop:meta key="value"/>` anywhere in conversation. Three reserved attributes:
- **file**: Custom transcript path (relative to project root, always `.jsonl`)
- **description**: Free-text description stored in meta record
- **tags**: Comma-separated tags, stored as array

All other attributes pass through as raw strings to the meta record.
Tool-result tags count only when the line holds the tag alone or as a JSON string value (a CLI printing JSON emits `"metatag": "<snoop:meta .../>"`), outside a ``` fence, and never from `Read`/`Grep`/`Glob`/`NotebookRead`/`WebFetch` (`standaloneTagLines()`, `CONTENT_TOOLS`). Otherwise a grepped docs example hijacks the capture path (#17). Prompts and assistant text are scanned whole.
Multiple tags per conversation: last one wins (no merging). Custom paths skip `latest` pointer and pruning.

## Context File

Place `.claude/snoop-context.json` in the project root to set default meta values:

```json
{ "project": "snoop", "team": "platform", "tags": "plugin,debug" }
```

Merge order: context file values < snoop meta tag values.
Built-in keys (`type`, `transcriptId`, `timing`, `tokens`, `outputByModel`, `outputBySpeed`, `contextWindow`, `subagentContext`, `tools`, `messageCount`, `toolCount`, `escInterrupts`, `subagents`, `workflows`, `lastAssistantPreview`, `incompleteCapture`, `trailingCapture`) cannot be overwritten by either source. `file` is only allowed in meta tags, not in the context file.

## When Editing

- **Status line format**: modify token/subagent/tool summary in `handleStop()`
- **Token calculation**: `lib/tokens.mjs` - all counts from API-reported usage. `finalUsageByRequest()` keeps one usage per `requestId`, the one with the largest `output_tokens`. A request's lines carry partial counts until the closing one, and line order is not reliably chronological, so never sort by timestamp and never sum per line.
- **Thinking split**: `calculateThinkingOutput()` in `lib/tokens.mjs` reads `output_tokens_details.thinking_tokens` (raw) or `thinking` (streamlined) from each request's final usage. The status line uses it only when `exact`, i.e. every request reported it; a partial sum would pass for the whole.
- **Context occupancy**: `lib/context.mjs`. Distinct from `lib/tokens.mjs`: totals sum every request and only grow, occupancy is one request's prompt size and drops on compaction, so a session can bill 4M tokens while occupying 90k. `calculateContextWindow()` reads the whole session file, not `combined`, since a turn's flow cannot show an earlier peak or compaction. Current occupancy is the last main-chain assistant message in file order, matching Claude Code's own extractor and the settle contract; `peak` is a maximum and needs no ordering, so neither path sorts by timestamp. `contextOccupancy()` uses the last entry of `usage.iterations` when there are several, since the top-level fields may aggregate them; every row observed so far has one. Rows whose occupancy is 0 are skipped: an `isApiErrorMessage` row carries a present-but-empty usage object, and 47 of 706 real sessions would otherwise have recorded a 0% reading for a turn whose window may have been nearly full. Context appears in the meta record and per-message fields only, never the status line — a live statusline already shows context there; snoop's job is capturing it for later review.
- **Window size**: transcript only. `MODEL_WINDOWS` in `lib/context.mjs` maps family-version to the model's maximum input window from Anthropic's model table; add a row when a model ships. `windowBasis` is `model` (listed), `observed` (unlisted, a reading on that same model passed 200k), or `unknown` (size and percentages `null`). The window follows the reading row's model, never a session-wide peak, so a `/model` switch is handled. Never read argv or `settings.json`: `ANTHROPIC_MODEL` and `/model` override both without a trace.
- **Message filtering**: `lib/messages.mjs` - `streamlineMessage()` controls captured fields
- **Meta tag parsing**: `lib/meta.mjs` - `scanForMetaTags()` extracts tag attributes. Always pass raw records, never streamlined ones: streamlining truncates tool results to 500 chars. ESC partials store their scan in a `meta-scan` record that `handleStop` strips on merge
- **Subagent loading**: `loadSubagentMessages()` in main script. `findSubagentFiles()` recurses, since Task agents sit in `subagents/` but Workflow agents sit in `subagents/workflows/wf_<runId>/`. Names, `description`, `spawnDepth`, and `isFork` come from `agent-<id>.meta.json` sidecars via `loadAgentSidecars()`; names fall back to `buildAgentNameMap()`. `collectRunInfo()` reads `durationMs` and workflow names from `toolUseResult` records across the whole session, since a workflow launched in an earlier turn still names its later agents. A workflow agent's `runId` is its `workflows/wf_<runId>/` directory. Subagent messages are bounded by `previousCaptureStart()`: the last `stop_hook_summary` naming snoop, minus its `durationMs`. Workflow agents run after `Workflow` returns `async_launched`, so bounding by the turn's first message lost 95% of them. The first capture in a session falls back to the turn start. `timing` uses main-chain records only.
- **Turn start**: `findLastUserPromptIndex()` walks back to the first external prompt sharing the last one's `promptId`, since a `!` command writes `<bash-input>` then `<bash-stdout>`. `isExternalUserPrompt()` rejects `isMeta` records. A Skill re-invocation injects an `isMeta` string after the prompt, which otherwise starts the capture mid-turn.

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
| `tokens` | object | Token usage breakdown. Output counts: `output` (legacy, undercounts subagents), `dedupedOutput` (main + subagent, deduped by `requestId`), `visibleOutput` (estimated readable text and tool calls, thinking excluded), `thinkingOutput` (API-reported thinking, deduped by `requestId`), `thinkingExact` (every request reported thinking) |
| `outputByModel` | object | Per-model output token counts, deduped by `requestId` (optional) |
| `outputBySpeed` | object | Output token counts by `usage.speed`, deduped by `requestId` (optional; absent when no request reports a speed) |
| `contextWindow` | object | Context occupancy at end of turn: `used`, `peak`, `size`, `windowBasis`, `usedPercentage`, `peakPercentage`, `model`, `peakModel`, `compactThreshold`, `headroom`, `compactions` (optional; absent when no assistant usage exists yet). `size`, the percentages, `compactThreshold`, and `headroom` are `null` when `windowBasis` is `unknown` |
| `subagentContext` | array | Per-subagent occupancy: `agentId`, `peak`, `size`, `peakPercentage`, `models`, plus optional `name`, `description` (the call's task label), `spawnDepth`, `isFork` (only when `true`), `durationMs` (from the Agent result; absent for workflow agents) |
| `workflows` | array | Workflow runs this capture touched, launched this turn or with agent messages in it: `runId`, `workflowName` (optional) |
| `subagents` | array | Subagent type names (if any) |
| `lastAssistantPreview` | string | Single-line preview of final assistant message, ≤200 chars (optional, Claude Code 2.1.101+). Absent means the turn produced no final assistant message, which is how failures are detected, except on a `trailingCapture` record, which has no turn. Empty string means it produced a blank one |
| `incompleteCapture` | boolean | Present and `true` only when the settle poll timed out. Token counts, `outputByModel`, and the preview are short |
| `trailingCapture` | boolean | Present and `true` only on a `SessionEnd` capture of subagent work after the last `Stop` |
| `description` | string | From meta tag or context file (optional) |
| `tags` | array | From meta tag or context file (optional) |
| `*` | any | Dynamic attributes from meta tag or context file |

### Message Records

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | `user`, `assistant`, or `interrupt` |
| `timestamp` | ISO string | Message timestamp |
| `uuid` | string | Message UUID |
| `parentUuid` | string | Parent message UUID |
| `requestId` | string | API request ID (for deduping streaming chunks) |
| `subagent` | string | Agent ID if from Task tool subagent |
| `toolUseResult` | object | `agentId` and `usage` on Task tool results; feeds `tokens.output` and name mapping |
| `message.model` | string | Model ID for this message (e.g. `claude-sonnet-4-6`). Varies per message when subagents use different models. |
| `message.content` | array | Blocks: `tool_use`, `tool_result`, `text`, `thinking` |
| `message.usage` | object | `input`, `output`, `cacheRead`, `cacheCreate`, `cache5m`, `cache1h` token counts, plus `context`: window occupancy at this request (`input + cacheCreate + cacheRead`, from the last entry of `usage.iterations` when a request made several). On a subagent row it is that agent's own window. Zero on API-error rows. `thinking` (exact thinking tokens) and `speed` appear when the row reports them |

Tool result text truncated to 500 chars, for both the string and array forms of `tool_result.content`. Image payloads are elided to `<elided N chars>`, since a base64 screenshot runs past 500,000 chars. Interrupt markers have `type: "interrupt"`, a `marker` banner string, and a `timestamp`.
