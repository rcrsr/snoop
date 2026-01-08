---
description: Analyze a Claude Code transcript and generate review report
argument-hint: "[transcript-id] [concern]"
---

# Transcript Review

Analyze a single-turn transcript to identify issues and improvement opportunities.

## Examples

```bash
/snoop:review                      # Analyze latest transcript
/snoop:review abc123               # Analyze specific transcript by ID
/snoop:review abc123 token usage   # Analyze with focus on token usage
```

## Step 1: Find Transcript File

**Arguments:** $ARGUMENTS

| Input Format | Resolution |
| ------------ | ---------- |
| `abc123.jsonl` | Use as-is |
| `abc123` (8 chars) | Append `.jsonl` |
| No identifier | Read from `latest` pointer |

Remaining text after identifier is the concern to focus on.

**If identifier provided:** Use `.claude/transcripts/{identifier}.jsonl`

**If no identifier:** Read from `.claude/transcripts/latest` pointer file, or fall back to:

```bash
ls -t .claude/transcripts/*.jsonl 2>/dev/null | head -1
```

If no transcript files exist, report to user and stop.

## Step 2: Analyze Transcript

Delegate to the transcript-reviewer agent with the resolved file path:

```
Use the transcript-reviewer agent to analyze {resolved_path}
```

If a concern was extracted from arguments, include it:

```
Use the transcript-reviewer agent to analyze {resolved_path}. Focus on: {concern}
```

## Step 3: Report Results

Present the review report. Include:

1. Path to analyzed transcript
2. Executive summary
3. Key findings with severity levels
4. Actionable recommendations

If critical issues found, highlight them prominently.
