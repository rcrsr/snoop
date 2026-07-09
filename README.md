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
| `Stop` | Session ends normally | Wait for the turn's final assistant message to reach the session file, merge any partial transcripts, write final JSONL, update `latest` pointer, prune old files. |
| `StopFailure` | Session ends in API error (rate limit, 5xx, auth) | Same pipeline as `Stop`, minus the wait. Resulting transcript never has `lastAssistantPreview`, which is how `/snoop:review` identifies a failed turn. Turns that fail before any assistant output also show `0` output tokens and `0` tool calls; turns that fail after tool calls retain both. |

**Final message capture:** Claude Code fires `Stop` before it flushes the turn's last assistant message to disk. Snoop polls for up to 1000 ms until the last conversation record is an assistant message, then captures. Without the wait, every transcript would lose its final API call: output tokens, model, and text.

**Message counting:** `messageCount` and duration cover conversation messages only. Claude Code interleaves twelve other record types into the session file (`attachment`, `mode`, `permission-mode`, `last-prompt`, `ai-title`, `file-history-snapshot`, `summary`, `progress`, `system`, `queue-operation`, `pr-link`, `agent-name`); Snoop excludes all of them. None carries a message body.

**Interrupt detection:** When you press ESC mid-response, Claude's last message contains a `tool_use` block that never received a `tool_result`. Snoop detects this pattern and inserts an interrupt marker before your next message.

**Subagent capture:** The Task tool spawns subagents that run in separate contexts. Snoop loads their transcripts from Claude Code's internal `subagents/` log directory and merges them into the main transcript, tagged with `subagent: "agent-xxx"`. Agents spawned by the Workflow tool are captured too: they write to `subagents/workflows/wf_<runId>/`, so Snoop searches recursively. Each agent is named from its `agent-<id>.meta.json` sidecar, giving `subagents: ["backend-engineer", "backend-code-reviewer"]` rather than raw IDs.

Workflow agents widen the gap between `tokens.output` and `tokens.dedupedOutput`, because a workflow never reports the per-agent usage aggregates that `tokens.output` depends on. See [Output Token Fields](#output-token-fields).

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
[snoop] abc12345 | 2m 30s | 45 msgs | 150,000 in (50,000 p / 15,000 cw5m / 5,000 cw1h / 80,000 cr / 53% ce) | 5,000 out (1,800 v / 3,200 r) | 20% s46 / 80% o47 | 2 si (Explore, claude-code-guide) | 12 ti (Read, Edit, Bash)
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
| `5,000 out` | Output tokens across main and subagent API calls |
| `1,800 v` | Visible output: text and tool calls you can read |
| `3,200 r` | Reasoning output: the rest, dominated by thinking blocks |
| `20% s46 / 80% o47` | Output share by model, sorted descending. Only shown when multiple models are used (e.g. subagents on a different model). Shortcodes: `s`=sonnet, `o`=opus, `h`=haiku + major + minor version digits. |
| `2 si (...)` | Subagent invocations with types (falls back to ID if unknown) |
| `12 ti (...)` | Tool invocations with list of unique tools used |

`v` and `r` sum to the `out` total. A high `r` relative to `v` means the turn spent most of its output budget thinking rather than producing text and tool calls. The breakdown is omitted when `v` exceeds `out`, which happens on a turn dominated by one large tool call, because `v` is a 4-chars/token estimate while `out` is API-reported.

A `⚠️ incomplete` marker means the turn's final assistant message never reached disk before the capture deadline, so the token counts are short. The meta record carries `incompleteCapture: true`.

**Notes:** `cw1h` only appears when 1-hour tier has tokens. Model breakdown only appears when >1 model is present. The `(v / r)` breakdown is omitted when output is `0`.

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

Context values merge into every transcript meta record. Snoop meta tags override context values when both exist. Built-in keys (`type`, `transcriptId`, `timing`, `tokens`, `outputByModel`, `tools`, `messageCount`, `toolCount`, `escInterrupts`, `subagents`, `lastAssistantPreview`) cannot be overwritten by either source. `file` is only allowed in meta tags, not in the context file.

## Output Token Fields

The meta record carries three output counts. They answer different questions, so they rarely match.

| Field | Meaning |
|-------|---------|
| `tokens.output` | Legacy count. Main-agent API calls plus whatever usage the Task tool reported for subagents. Undercounts subagent work whenever `toolUseResult` carries no `agentId`, which is always the case for Workflow agents. Semantics frozen so old transcripts stay comparable. |
| `tokens.dedupedOutput` | API-reported output tokens across main and subagent messages, deduplicated by `requestId`. The number shown as `out` in the status line. |
| `tokens.visibleOutput` | Estimated tokens you can actually read: characters of `text` blocks plus each tool call's name and JSON input, at 4 chars/token. Thinking blocks excluded. |

Reasoning output is the residual, `dedupedOutput - visibleOutput`, floored at `0`. Because `visibleOutput` is a 4-chars/token estimate rather than an API-reported count, that residual carries the estimate's error alongside the thinking tokens. Treat it as an indicator, not a measurement. It is most trustworthy on large turns, where the estimation error is small next to the totals.

Assistant messages arrive as one JSONL line per content block. Those lines do not repeat the same `usage`: the intermediate ones carry a partial `output_tokens` and only the closing line carries the request's total, for example `1, 1, 1, 1, 276`. Both `dedupedOutput` and `visibleOutput` account for this. The first keeps one usage per `requestId`, the one with the largest `output_tokens`, which is the closing line. The second sums characters across lines and deduplicates only exact `uuid` repeats.

## Last Assistant Preview

When running on Claude Code 2.1.101+, the meta record includes a `lastAssistantPreview` field: a trimmed, single-line preview of the turn's final assistant message (up to 200 characters, with `…` suffix when truncated). Useful for quickly scanning transcripts in a list. Omitted from the record when Claude Code didn't supply the data (older versions, or StopFailure turns that ended before any assistant output).

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
  "message": { "role": "user|assistant", "model": "claude-sonnet-4-6", "content": "..." }
}
```

Interrupt markers inserted when user hits ESC:

```json
{
  "type": "interrupt",
  "marker": "═══════════════════ ⚠️ USER HIT ESC ═══════════════════"
}
```
