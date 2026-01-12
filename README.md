# snoop

Captures Claude Code run transcripts for debugging and review.

## Why snoop?

**Debug failed sessions.** Review exactly what happened when Claude went off track. See every tool call, every decision point, every interrupt.

**Catch anti-patterns.** The reviewer agent identifies loops, scope creep, redundant file reads, and incomplete work—issues that waste tokens and time.

**ESC interrupt tracking.** Know when and why you interrupted Claude. Partial transcripts are preserved and merged into the final record.

**Zero friction.** Runs automatically on every session. Keeps last 10 transcripts, auto-cleans older ones. No manual capture needed.

## Installation

```bash
# From marketplace
/plugin marketplace add rcrsr/claude-plugins
/plugin install snoop@rcrsr

# Or load locally
claude --plugin-dir /path/to/snoop
```

## Quick Start

```bash
# Review your last session
/snoop:review

# Review specific transcript
/snoop:review abc12345

# Focus on specific concern
/snoop:review token usage
```

## Commands

| Command | Description |
|---------|-------------|
| `/snoop:review [id] [concern]` | Analyze transcript, generate post-mortem report |

## Output

Transcripts saved to `.claude/transcripts/`:

```
.claude/transcripts/
├── latest          # Pointer to most recent
├── abc12345.jsonl  # Current transcript
└── def67890.jsonl  # Previous transcript
```

## Transcript Format

JSONL with one message per line:

```json
{
  "type": "user|assistant|interrupt",
  "timestamp": "ISO-8601",
  "uuid": "message-uuid",
  "message": { "role": "user|assistant", "content": "..." }
}
```

Interrupt markers inserted when user hits ESC:

```json
{
  "type": "interrupt",
  "marker": "═══════════════════ ⚠️ USER HIT ESC ═══════════════════"
}
```
