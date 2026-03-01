# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
