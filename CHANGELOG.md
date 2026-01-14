# Changelog

## 1.2.8

- Deduplicate subagent names in status line (multiple subagents of same type now show once)

## 1.2.7

- Skip 0-value token breakdowns in status line for cleaner output

## 1.2.6

- Add cache token tier breakdown (cw5m, cw1h, cr) to status line
- Resolve subagent IDs to human-readable names (Explore, Plan, etc.)

## 1.2.5

- Add detailed token breakdown showing prompt vs cache tokens
- Display subagent types and tool usage in status line

## 1.2.4

- Fix duration calculation by filtering subagent messages to current turn only

## 1.2.3

- Enhance transcript reviewer agent documentation

## 1.2.2

- Fix timestamp ordering for accurate duration and token usage calculations

## 1.2.1

- Improve token counting accuracy in capture script

## 1.2.0

- Add subagent message capture from Claude Code's internal logs
- Merge subagent transcripts into main transcript with `subagent` field tagging
