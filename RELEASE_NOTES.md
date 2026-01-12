# Release Notes

## 1.2.2

**Timestamp Ordering Fix**

- Sort messages chronologically before calculating duration and token usage
- Fixes negative duration bug when subagent messages (appended last) have earlier timestamps
- Fixes token counting capturing intermediate cumulative values instead of final totals

## 1.2.1

**Accurate Token Counting**

- Input tokens: API-reported (reliable, includes system prompt + cache)
- Output tokens: `toolUseResult.usage` for subagents + content estimate (chars/4) for main
- Capture `toolUseResult` field from Task tool completions (contains accurate final counts)

**Why not use streaming `output_tokens`?** Claude Code writes transcript chunks during streaming, but doesn't always capture the final chunk with accurate totals. Some requests show `output_tokens: 1` despite generating thousands of characters. The `toolUseResult` is written after completion with correct values.

## 1.2.0

**Subagent Transcript Capture**

- Include subagent messages in captured transcripts (Task tool spawns subagents)
- Tag subagent messages with `subagent: "agent-xxx"` for identification
- Aggregate token usage across main transcript and all subagents
- Display subagent count in summary: `51 messages | 4 subagents`
- Handle both raw (`input_tokens`) and streamlined (`input`) token formats

## 1.1.0

**Token Usage Tracking**

- Capture `input`, `output`, `cacheCreate`, `cacheRead` tokens per assistant message
- Add `requestId` to messages for deduping streaming chunks
- Display token summary in hook output: `51,545 / 2,847 tokens (in / out)`
- Calculate totals by grouping on `requestId` to avoid double-counting

## 1.0.1

- Update plugin author details
- Enhance transcript reviewer documentation

## 1.0.0

- Initial release
- Capture run transcripts to `.claude/transcripts/`
- Detect ESC interrupts via `UserPromptSubmit` hook
- Write complete transcripts on `Stop` hook
- Keep last 10 transcripts with `latest` pointer
- Transcript reviewer agent for post-mortem analysis
