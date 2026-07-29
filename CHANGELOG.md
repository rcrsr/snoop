# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- Context-window occupancy in the status line: `ctx 15% (150k/1M) f5` after the message count — how full the window is at the end of the turn, the occupied tokens over the window size, and the model the reading is measured against. Occupancy is exact, taken from the same `input + cacheCreate + cacheRead` sum over the same final message that Claude Code's own context readout uses. Appends `peak N%` when the session has compacted (the only way to see how close it came to the limit) and a `−Nk` entry per compaction with its trigger and dropped tokens.
- `contextWindow` in the meta record: `used`, `peak`, `size`, `windowBasis`, `usedPercentage`, `peakPercentage`, `model`, `compactThreshold`, `headroom`, `compactions`. Occupancy answers a different question from the token totals: totals sum every request and only grow, occupancy is one request's prompt size and drops on compaction, so a session can bill 4M tokens while occupying 90k.
- Per-subagent context in the status line (`sub ctx: Explore s5 367k / claude-code-guide h45 48k`) and meta record (`subagentContext`: `agentId`, `peak`, `models`, `name`). A subagent runs its own window, so these are separate readings, not slices of the parent's — which is how a 367k Explore agent inside a 150k session is traced back to the agent type and model that produced it.
- `context` on every captured message's `usage`: window occupancy at that request, so the transcript carries a context footprint per log item and the growth curve is readable straight off the file. On a subagent row it reads against that agent's own window.
- Window-size inference with an honesty marker. The window is not recoverable from `message.model` — a session running `opus[1m]` records plain `claude-opus-5` (verified on a session that reached 989,865 tokens). Signals, strongest first: occupancy above 200k (proof), `--model` in the running process's argv via `CLAUDE_PID`, the `model` in settings.json. An explicit `--model` overrides settings, so `--model haiku` against a `[1m]` default correctly reads 200k. When nothing settles it, the percentage is prefixed `~` and `windowBasis` says `assumed`: the tokens are exact, only the denominator is a guess.
- `transcript-reviewer` gains a "Context Pressure" issue category (peak near the limit, compactions explaining lost history), context metrics in its report, and a growth-curve survey command over the per-message footprint.

## [1.7.1] - 2026-07-08

### Fixed

- `modelShortcode` left single-version model IDs unabbreviated in the status-line model breakdown. The regex required two numeric segments (`claude-opus-4-8` → `o48`), so `claude-sonnet-5` failed to match and printed its full ID, yielding a mixed line like `64% claude-sonnet-5 / 36% o48`. The second segment is now optional (`claude-sonnet-5` → `s5`) and the family map covers `fable`/`mythos` alongside `sonnet`/`opus`/`haiku`.

## [1.7.0] - 2026-07-08

### Added

- `tokens.visibleOutput` in the meta record: estimated visible output tokens, counting characters of `text` blocks plus each `tool_use` block's name and JSON-serialized input, at 4 chars/token. Thinking blocks are excluded. Covers main and subagent messages.
- `tokens.dedupedOutput` in the meta record: API-reported output tokens across main and subagent messages, keeping one usage per `requestId`. The correct denominator for `visibleOutput`, since both cover the same messages; the legacy `tokens.output` undercounts subagent work whenever `toolUseResult` carries no `agentId`, and keeps its semantics unchanged for longitudinal comparability.
- `outputByModel` in the meta record: per-model output token counts, previously computed for the status line only.
- `transcript-reviewer` recognizes turn failures captured by the `StopFailure` hook and diagnoses their cause. New "Turn Failure (API Error)" issue category, severity rules keyed on unresolved `tool_use` blocks, and a cross-reference to the live session JSONL where the error is recorded as an assistant message flagged `isApiErrorMessage`. Adapted from #3 by @tedserbinski. Detection keys on the absence of `lastAssistantPreview` rather than a four-signal shape match, which misses turns that fail after tool calls have run.
- Output composition in the status line: `| 9,572 out (3,672 v / 5,900 r)`, where `v` is `visibleOutput` and `r` is the residual `dedupedOutput - visibleOutput`. The residual is reasoning tokens plus the `visibleOutput` estimate's own error, floored at 0. Omitted when output is 0.

### Changed

- Status line `out` now reports `tokens.dedupedOutput` rather than `tokens.output`, so the `v`/`r` parts sum to the displayed total. The two totals are identical on turns without subagents; on subagent turns the displayed value rises, because `tokens.output` was undercounting.
- The Stop hook does less work before returning. The settle poll checks the session file's size and only re-parses once it grows, saving roughly 164 ms of parsing per slow turn on a 2.3 MB session. Subagent transcripts whose last write predates the turn are never opened, which skips 104 of 105 files on the largest real subagents directory. The `subagents/` tree is walked once per Stop rather than twice, sidecars are read only when the turn spawned an agent, and dropping the two timestamp sorts takes the four token passes from 19 ms to 0.6 ms.
- A turn whose only timestamped record is the user prompt now reports elapsed time instead of `unknown`, closing the span against the hook's wall clock, stamped before the settle poll so the wait is excluded. This affects turns that fail before the assistant replies. Claude Code's `system/turn_duration` record cannot supply this: it is written after the Stop hook returns, exists in 60% of sessions, and its `messageCount` is a session-wide running total rather than a per-turn count.

- `incompleteCapture` in the meta record, plus an `⚠️ incomplete` status-line marker. Set when the settle poll times out before the final assistant message lands, so short token counts are never mistaken for real ones.

### Fixed

- `tokens.output` and `outputByModel` undercounted. Both sorted messages by timestamp, then kept the last usage per `requestId`. A request's JSONL lines do not repeat one usage: intermediate lines carry a partial `output_tokens` and only the closing line carries the total. A closing line can bear an earlier timestamp than a partial one, sort behind it, and lose. Measured across 600 real session files: 16 undercounted, the worst by 2,276 tokens (17.8%), 8,486 tokens lost in total. All three token functions now select the usage with the largest `output_tokens` per request, which is order-independent and needs no sort. Verified identical under reversed and shuffled input on all 600 files.
- A corrupt partial transcript aborted every subsequent capture for that session. `handleStop` parsed `.partial_<session>.jsonl` with a bare `JSON.parse` per line, so one truncated line threw before `fs.unlinkSync` ran, leaving the file to fail the next Stop the same way. Both partial readers now use `readJsonLines`, which skips malformed lines.
- The settle poll could exit on an assistant line holding only a `tool_use`, capturing the turn as of that tool call. A fixture whose final message lands 300 ms late captured `2 msgs | 10 out` instead of `4 msgs | 510 out`. The poll now waits for an assistant message with no pending `tool_use`.
- An unreadable or removed `subagents/` subdirectory crashed the hook before the transcript was written, losing the whole turn. `findSubagentFiles` now returns `[]` on `readdirSync` failure.
- `StopFailure` wrote `lastAssistantPreview` from the hook input, contradicting the documented invariant that failed turns never carry it and breaking the reviewer's detection. The field is now forced absent on `StopFailure`.
- A blank final assistant message produced a null preview, so a completed turn was indistinguishable from a failed one. A blank reply now records an empty string; only a missing message omits the field.
- `elideImage` assumed a base64 source and rebuilt the block, dropping the `url` of url-sourced images along with `media_type` and any other fields, while reporting `<elided 0 chars>`. Non-base64 image blocks now pass through untouched.
- Status line printed `v` and `r` parts that exceeded their own total when the `visibleOutput` estimate overshot the API-reported total, as on a turn dominated by one large tool call. The breakdown is now omitted in that case.
- `calculateTiming` closed the span at the hook clock only for single-message turns, so a turn whose final message never landed reported the time to its last `tool_result`. The turn now always ends at the later of its last timestamp and the hook clock.
- Workflow agents were never captured. `getSubagentFiles()` read `subagents/` without recursing, but Workflow agents write to `subagents/workflows/wf_<runId>/`, so only Task subagents were found. On a measured 21-agent workflow run this dropped 59,959 output tokens (55% of all subagent output) and 252 tool calls, with no signal in the transcript that anything was missing. Discovery is now recursive, matching `agent-*.jsonl` so `journal.jsonl` stays excluded.
- Subagent names now come from the `agent-<id>.meta.json` sidecar Claude Code writes beside each agent transcript. `buildAgentNameMap()` pairs `Task` tool_use blocks with `toolUseResult.agentId`, which Workflow agents never produce, so they would otherwise land in the `subagents` array as raw `agent-a0a95cc0…` IDs. The tool_use pairing remains as a fallback.
- `calculateVisibleOutput()` deduplicated by `requestId` when a message had no `uuid`. A request spans one line per content block, so this dropped every block after the first, undercounting characters. Deduplication now happens on `uuid` only.
- Turn's final assistant message was never captured. Claude Code invokes `Stop` before flushing that record to the session file, so every transcript ended at the last `tool_result`, dropping the final API call's output tokens, model, and text. Turns with no tool calls reported `0` for all token counts. `Stop` now polls the session file for up to 1000 ms (50 ms interval) until the last conversation record is an assistant message. `StopFailure` reads once, since no final assistant message is coming.
- `messageCount` and `timing` counted non-conversation records. `shouldSkipMessage()` is now an allow-list keeping only `user`/`assistant` records with a `message` body plus snoop's `interrupt` marker, so the twelve bookkeeping record types Claude Code interleaves are excluded, as is any type it adds later. A survey of 512,168 records across 7,319 session files found these in 62% of captured turns. A single prompt-and-reply turn reported `9 msgs` and `0s`; it now reports `2 msgs` and the true duration.
- `tool_result.content` was only truncated in its string form. The array form passed through verbatim, including base64 image payloads. The largest such result on disk measured 601,251 chars. Text blocks inside array content are now truncated to 500 chars and image payloads elided, reducing that result to 176 chars. Image blocks in assistant messages are elided the same way.

## [1.6.1] - 2026-04-20

### Added

- `message.model` captured per assistant message. Subagents running on different models each carry their own model ID.
- Model breakdown in status line when multiple models are used: `... | 5,000 out | 20% s46 / 80% o47 | ...`. Sorted by descending output share. Shortcodes: `s`=sonnet, `o`=opus, `h`=haiku + major + minor version digits. Omitted for single-model sessions.

## [1.6.0] - 2026-04-20

### Added

- `StopFailure` hook: captures transcripts when turns end in API errors (rate limit, 5xx, auth failure). Fires instead of `Stop` on failure; same capture pipeline.
- `lastAssistantPreview` in meta record: single-line preview of the turn's final assistant message, up to 200 chars with `…` suffix when truncated. Requires Claude Code 2.1.101+; omitted on older versions and StopFailure turns.
- `/snoop:review` migrated to `skills/review/SKILL.md` (Claude Code 2.1.3+ skills system). Auto-discoverable by intent; slash command invocation unchanged.

### Removed

- `commands/review.md` replaced by `skills/review/SKILL.md`.

## [1.5.0] - 2026-03-08

### Added

- Dynamic meta tag attributes: any `key="value"` beyond reserved keys passes through to meta record
- Context file support: `.claude/snoop-context.json` sets default meta values for all transcripts
- Built-in key protection: `type`, `transcriptId`, `timing`, `tokens`, etc. cannot be overwritten

### Changed

- `parseMetaAttributes` accepts all attributes, not just `file`/`description`/`tags`
- `buildMetaRecord` merges context file (layer 1) then meta tag (layer 2) with reserved key guards

## [1.4.5] - 2026-03-01

### Fixed

- Resolve subagent names after Claude Code renamed `Task` tool to `Agent`

### Changed

- Use API-reported output tokens instead of content-based estimation
- Status line format: remove outer brackets, add `[snoop]` prefix

### Removed

- `getContentLength` and `estimateTokensFromContent` from `tokens.mjs`

## [1.4.4] - 2026-02-01

### Fixed

- Skip `progress` messages (heartbeat entries with no content)

## [1.4.3] - 2026-02-01

### Fixed

- Always use `.jsonl` extension for transcripts (replace any user-provided extension)

## [1.4.2] - 2026-01-31

### Changed

- Meta tag file paths are now relative to project root (not transcripts dir)

## [1.4.1] - 2026-01-31

### Fixed

- Unescape JSON strings in meta tag scanning to match tags with escaped quotes

## [1.4.0] - 2026-01-31

### Added

- Meta tag support: `<snoop:meta file="..." description="..." tags="..."/>`
- Meta record as first line of transcript with summary stats
- Custom transcript paths with subdirectory support
- Description and tags fields in meta record

### Changed

- Modularize script into `lib/` directory:
  - `lib/helpers.mjs` - File I/O, duration formatting
  - `lib/messages.mjs` - Message filtering, streamlining, analysis
  - `lib/tokens.mjs` - Token calculation and estimation
  - `lib/meta.mjs` - Meta tag scanning and parsing
- Pruning only affects default-named transcripts (not subdirs)
- Latest pointer only updated for default-named transcripts
- Status line shows custom path indicator when meta tag specifies file

## [1.3.0] - 2026-01-27

### Changed

- Status line labels: `subagent(s)` → `si` (subagent invocations), `tools` → `ti` (tool invocations)
- Extract `subagentCount` variable for clarity
- Migrate RELEASE_NOTES.md to CHANGELOG.md (Keep a Changelog format)

## [1.2.9] - 2026-01-22

### Added

- Cache efficiency percentage (ce) in token breakdown: `63% ce`

## [1.2.8] - 2026-01-14

### Fixed

- Deduplicate subagent names in status line

## [1.2.7] - 2026-01-13

### Changed

- Skip 0 values in token breakdown instead of showing all fields

## [1.2.6] - 2026-01-13

### Added

- Cache write tier breakdown: `cw5m` (5-minute) and `cw1h` (1-hour ephemeral)
- Capture `cache5m` and `cache1h` fields in usage data

### Fixed

- Subagent name resolution for `agent-xxx` prefix
- Filter out `summary` messages (Claude Code context metadata)

## [1.2.5] - 2026-01-13

### Changed

- Token format: `150,000 in (50,000 p / 20,000 cw / 80,000 cr) | ~5,000 out`
- Subagent types listed in status: `2 subagents (Explore, claude-code-guide)`
- Rename "tool calls" to "tools" for brevity

### Fixed

- Exclude subagent messages from `byRequest` to prevent double-counting input tokens
- Capture `toolUseResult.agentId` when usage data is missing
- Capture `tool_use.id` for name mapping

## [1.2.4] - 2026-01-12

### Fixed

- Filter subagent messages to current turn only
- Fixes inflated duration when session contains subagents from previous turns

## [1.2.3] - 2026-01-12

### Changed

- Transcript reviewer agent: add role definition, imperative workflow, survey commands
- Add issue categories: "Subagent Misuse" and "Token Waste"
- Use `haiku` model for cost-effective analysis

## [1.2.2] - 2026-01-12

### Fixed

- Sort messages chronologically before calculating duration and token usage
- Fixes negative duration bug when subagent messages have earlier timestamps

## [1.2.1] - 2026-01-12

### Changed

- Input tokens sourced from API-reported values
- Output tokens from `toolUseResult.usage` for subagents + content estimate for main

### Added

- Capture `toolUseResult` field from Task tool completions

## [1.2.0] - 2026-01-12

### Added

- Subagent transcript capture (Task tool spawns)
- Tag subagent messages with `subagent: "agent-xxx"`
- Aggregate token usage across main transcript and all subagents
- Display subagent count in summary

## [1.1.0] - 2026-01-12

### Added

- Token usage tracking: `input`, `output`, `cacheCreate`, `cacheRead` per message
- `requestId` for deduping streaming chunks
- Token summary in hook output

## [1.0.1] - 2026-01-07

### Changed

- Update plugin author details
- Enhance transcript reviewer documentation

## [1.0.0] - 2026-01-06

### Added

- Capture run transcripts to `.claude/transcripts/`
- Detect ESC interrupts via `UserPromptSubmit` hook
- Write complete transcripts on `Stop` hook
- Keep last 10 transcripts with `latest` pointer
- Transcript reviewer agent for post-mortem analysis
