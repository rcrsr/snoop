# Snoop

Captures, processes, and summarizes Claude Code run transcripts for debugging and review.

<img width="1007" height="188" alt="Screenshot 2026-01-13 135330" src="https://github.com/user-attachments/assets/96b3bb32-2349-4d53-ae06-1941dfe8ded0" />

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

**Subagent capture:** The Task tool spawns subagents that run in separate contexts. Snoop loads their transcripts from Claude Code's internal `subagents/` log directory and merges them into the main transcript, tagged with `subagent: "agent-xxx"`.

**File lifecycle:**
1. During session: partial transcripts saved as `.partial_{session_id}.jsonl`
2. On stop: partials merged into `{random_id}.jsonl` (8-char ID)
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

## Status Line

After each session, Snoop outputs a status line:

```
[snoop] abc12345 | 2m 30s | 45 msgs | 150,000 in (50,000 p / 15,000 cw5m / 5,000 cw1h / 80,000 cr / 53% ce) | 5,000 out | 2 si (Explore, claude-code-guide) | 12 ti (Read, Edit, Bash)
```

| Field | Meaning |
|-------|---------|
| `abc12345` | Transcript ID (use with `/snoop:review abc12345`) |
| `2m 30s` | Session duration |
| `45 msgs` | Total messages captured |
| `150,000 in` | Total input tokens (prompt + cache read + cache write) |
| `50,000 p` | Prompt tokens (non-cached input) |
| `15,000 cw5m` | Cache write tokens (5-minute ephemeral tier) |
| `5,000 cw1h` | Cache write tokens (1-hour ephemeral tier) |
| `80,000 cr` | Cache read tokens |
| `53% ce` | Cache efficiency (cache read / total input) |
| `5,000 out` | Output tokens |
| `2 si (...)` | Subagent invocations with types (falls back to ID if unknown) |
| `12 ti (...)` | Tool invocations with list of unique tools used |

**Note:** `cw1h` only appears when 1-hour tier has tokens. Otherwise shows just `cw5m`.

**With ESC interrupts:**
```
[abc12345 | 1m 15s | ⚠️ 2x ESC | 23 msgs | ...]
```

## Gotchas

**Focus mode hides the status line.** Claude Code's focus mode (toggle with `/focus`) suppresses all hook `systemMessage` output, so you won't see the `[snoop] ...` line after each turn. Transcripts are still captured to disk — only the UI notification is hidden. Toggle focus off with `/focus` if you want the live status back.

## Token Counting

All token counts are API-reported. Main conversation usage comes from streaming message chunks (last chunk per request carries the cumulative total). Subagent usage comes from `toolUseResult.usage`.

## Meta Tags

Add `<snoop:meta key="value" .../>` anywhere in conversation to enrich the transcript meta record.

**Reserved attributes** (special handling):

| Attribute | Effect |
|-----------|--------|
| `file` | Custom transcript path (relative to project root, always `.jsonl` extension) |
| `description` | Free-text description stored in meta record |
| `tags` | Comma-separated tags, stored as array |

All other attributes pass through as raw strings. Built-in record keys (`type`, `transcriptId`, `timing`, `tokens`, etc.) cannot be overwritten.

When multiple meta tags appear, the last one wins (no merging). Custom paths skip `latest` pointer and pruning.

**Example:**
```
<snoop:meta file="transcripts/auth-refactor" description="OAuth2 migration" tags="auth,refactor" initiative="AUTH-42"/>
```

## Context File

Place `.claude/snoop-context.json` in your project to set default meta values for all transcripts:

```json
{
  "project": "my-app",
  "team": "platform",
  "tags": "backend,api"
}
```

Context values merge into every transcript meta record. Snoop meta tags override context values when both exist. Built-in keys (`type`, `transcriptId`, `timing`, `tokens`, `tools`, `messageCount`, `toolCount`, `escInterrupts`, `subagents`) cannot be overwritten by either source. `file` is only allowed in meta tags, not in the context file.

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
