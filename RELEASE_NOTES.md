# Release Notes

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
