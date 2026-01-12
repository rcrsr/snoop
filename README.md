# Snoop

Captures Claude Code run transcripts for debugging and review.

## Why Snoop?

**Observability.** Claude Code makes it difficult to review a specific transcript for a run. Snoop groups relevant messages by user prompt in your project ('.claude/transcripts') to make post-mortem analysis easier.

**Debug failed sessions.** When Claude goes off track, review the transcript to find where and why.

**Catch anti-patterns.** The reviewer agent identifies loops, scope creep, redundant reads, and incomplete work.

**ESC interrupt tracking.** Partial transcripts preserve exactly where you interrupted and what was pending.

**Zero friction.** Runs automatically. Keeps 10 transcripts, auto-cleans older ones.

## How it works

Snoop uses Claude Code's hook system to capture transcripts at two points:

| Hook | Trigger | Action |
|------|---------|--------|
| `UserPromptSubmit` | User sends a message | Check for pending `tool_use` without `tool_result` (indicates ESC interrupt). Save partial transcript with interrupt marker. |
| `Stop` | Session ends | Merge any partial transcripts, write final JSONL, update `latest` pointer, prune old files. |

**Interrupt detection:** When you press ESC mid-response, Claude's last message contains a `tool_use` block that never received a `tool_result`. Snoop detects this pattern and inserts an interrupt marker before your next message.

**Subagent capture:** The Task tool spawns subagents that run in separate contexts. Snoop extracts their transcripts from `toolUseResult` fields and merges them into the main transcript, tagged with `subagent: "agent-xxx"`.

**File lifecycle:**
1. During session: partial transcripts saved as `.partial_{session_id}.jsonl`
2. On stop: partials merged into `{session_id}.jsonl`
3. Cleanup: keeps 10 most recent transcripts, deletes older ones

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

## Token Counting

Summary output shows `X / Y tokens (in / out)`:

| Type | Source | Reason |
|------|--------|--------|
| Input | API-reported | Reliable (includes system prompt, history, cache) |
| Output | Hybrid | Streaming counts unreliable, see below |

**Output token strategy:**
- Subagents: `toolUseResult.usage.output_tokens` (accurate final count)
- Main conversation: content estimate (chars/4)

**Why not use streaming `output_tokens`?** The API reports cumulative output tokens, but Claude Code doesn't always capture the final streaming chunk with the correct total. Example from real transcript:

```
Request A: 3 chunks, output_tokens: 8 → 8 → 243   ✓ (final chunk captured)
Request B: 2 chunks, output_tokens: 1 → 1         ✗ (final chunk missing, actual: ~500)
```

The `toolUseResult` field on Task completions is written after the subagent finishes, so it contains correct cumulative values. Main conversation falls back to content estimation.
