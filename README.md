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

Snoop uses four Claude Code hooks:

| Hook | Trigger | Action |
|------|---------|--------|
| `UserPromptSubmit` | User sends a message | Check for an ESC interrupt: a pending `tool_use` without `tool_result`, or Claude Code's `[Request interrupted by user]` marker. Save partial transcript with interrupt marker. |
| `Stop` | Turn ends normally | Wait for the turn's final assistant message to reach the session file, merge any partial transcripts, write final JSONL, update `latest` pointer, prune old files. |
| `StopFailure` | Turn ends in an API error (rate limit, 5xx, auth) | Same pipeline as `Stop`, minus the wait. Resulting transcript never has `lastAssistantPreview`, which is how `/snoop:review` identifies a failed turn. Turns that fail before any assistant output also show `0` output tokens and `0` tool calls; turns that fail after tool calls retain both. |
| `SessionEnd` | Session closes | Capture subagent work written after the last `Stop`, typically a workflow still running as you close the session. Writes nothing when there is none. The transcript carries `trailingCapture: true`. |

**Final message capture:** Claude Code fires `Stop` before it flushes the turn's last assistant message to disk. Snoop polls for up to 1000 ms until the last conversation record is an assistant message, then captures. Without the wait, every transcript would lose its final API call: output tokens, model, and text.

**Message counting:** `messageCount` and duration cover conversation messages only: `user` and `assistant` records carrying a message body, plus Snoop's own interrupt markers. Claude Code interleaves at least sixteen bookkeeping record types into the session file (`attachment`, `file-history-snapshot`, `system`, `queue-operation`, and others). Snoop keeps an allow-list rather than naming them, so a new type never inflates the count.

**Interrupt detection:** When you press ESC mid-response, Claude Code writes a `[Request interrupted by user]` marker, and if a tool was running, the last assistant message holds a `tool_use` that never received a `tool_result`. Snoop detects either sign and inserts an interrupt marker before your next message. The marker is the only sign of an ESC during a text or thinking reply.

**Subagent capture:** The Task tool spawns subagents that run in separate contexts. Snoop loads their transcripts from Claude Code's internal `subagents/` log directory and merges them into the main transcript, tagged with `subagent: "agent-xxx"`. Agents spawned by the Workflow tool are captured too: they write to `subagents/workflows/wf_<runId>/`, so Snoop searches recursively. Each agent is named from its `agent-<id>.meta.json` sidecar, giving `subagents: ["backend-engineer", "backend-code-reviewer"]` rather than raw IDs. Workflow agents start after the Workflow call returns, so they often run between turns; each capture takes every subagent message written since the previous capture started, so that work lands in the next turn's transcript.

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

After each turn, Snoop outputs a status line:

```
[snoop] abc12345 | 2m 30s | 45 msgs | 150,000 in (50,000 p / 15,000 cw5m / 5,000 cw1h / 80,000 cr / 53% ce) | 5,000 out (1,800 v / 3,200 r) | 20% s46 / 80% o47 | 2 si (Explore, claude-code-guide) | 12 ti (Read, Edit, Bash)
```

| Field | Meaning |
|-------|---------|
| `abc12345` | Transcript ID (use with `/snoop:review abc12345`) |
| `2m 30s` | Turn duration |
| `45 msgs` | Total messages captured |
| `150,000 in` | Total input tokens (prompt + cache read + cache write), main agent plus Task-reported subagent usage |
| `50,000 p` | Prompt tokens (non-cached input) |
| `15,000 cw5m` | Cache write tokens (5-minute ephemeral tier) |
| `5,000 cw1h` | Cache write tokens (1-hour ephemeral tier) |
| `80,000 cr` | Cache read tokens |
| `53% ce` | Cache efficiency (cache read / total input) |
| `5,000 out` | Output tokens across main and subagent API calls |
| `1,800 v` | Visible output: text and tool calls you can read |
| `3,200 r` | Reasoning output: thinking tokens |
| `20% s46 / 80% o47` | Output share by model, sorted descending. Only shown when multiple models are used (e.g. subagents on a different model). Shortcodes: `s`=sonnet, `o`=opus, `h`=haiku + major + minor version digits. |
| `2 si (...)` | Subagent invocations with types (falls back to ID if unknown) |
| `12 ti (...)` | Tool invocations with list of unique tools used |

`v` and `r` sum to the `out` total. A high `r` relative to `v` means the turn spent most of its output budget thinking rather than producing text and tool calls. When every request in the turn reports its thinking tokens (Claude Code 2.1.284+), `r` is that exact count. Otherwise `v` falls back to a 4-chars/token estimate, and the breakdown is omitted when that estimate exceeds `out`, which happens on a turn dominated by one large tool call.

A `⚠️ incomplete` marker means the turn's final assistant message never reached disk before the capture deadline, so the token counts are short. The meta record carries `incompleteCapture: true`.

**Notes:** `cw1h` only appears when 1-hour tier has tokens. Model breakdown only appears when >1 model is present. The `(v / r)` breakdown is omitted when output is `0`.

**With ESC interrupts:**
```
[snoop] abc12345 | 1m 15s | ⚠️ 2x ESC | 23 msgs | ...
```

**With a custom path** from a meta tag:
```
[snoop] abc12345 → transcripts/auth-refactor | 2m 30s | ...
```

## Gotchas

**Focus mode hides the status line.** Claude Code's focus mode (toggle with `/focus`) suppresses all hook `systemMessage` output, so you won't see the `[snoop] ...` line after each turn. Transcripts are still captured to disk — only the UI notification is hidden. Toggle focus off with `/focus` if you want the live status back.

## Token Counting

All token counts are API-reported. A request spans several streamed lines; Snoop keeps the one with the largest `output_tokens` per `requestId`, which is the closing line. Input and cache totals cover main-agent requests plus the usage the Task tool reports in `toolUseResult.usage`, so they miss Workflow agents. `out` (`tokens.dedupedOutput`) reads every main and subagent message, so it includes them. See [Output Token Fields](#output-token-fields).

## Meta Tags

Add `<snoop:meta key="value" .../>` anywhere in conversation to enrich the transcript meta record.

**Reserved attributes** (special handling):

| Attribute | Effect |
|-----------|--------|
| `file` | Custom transcript path (relative to project root, always `.jsonl` extension) |
| `description` | Free-text description stored in meta record |
| `tags` | Comma-separated tags, stored as array |

All other attributes pass through as raw strings. Built-in record keys (`type`, `transcriptId`, `timing`, `tokens`, etc.) cannot be overwritten.

Tags count anywhere in prompts and assistant text. In tool output, a tag counts only when its line holds the tag alone or as a JSON string value (`"metatag": "<snoop:meta .../>"`), outside a ``` fence, and not from `Read`, `Grep`, `Glob`, `NotebookRead`, or `WebFetch`. A CLI that prints the tag registers the transcript; a `grep` or `cat` of docs showing an example does not.

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

Context values merge into every transcript meta record. Snoop meta tags override context values when both exist. Built-in keys (`type`, `transcriptId`, `timing`, `tokens`, `outputByModel`, `outputBySpeed`, `contextWindow`, `subagentContext`, `tools`, `messageCount`, `toolCount`, `escInterrupts`, `subagents`, `workflows`, `lastAssistantPreview`, `incompleteCapture`, `trailingCapture`) cannot be overwritten by either source. `file` is only allowed in meta tags, not in the context file.

## Output Token Fields

The meta record carries three output counts. They answer different questions, so they rarely match.

| Field | Meaning |
|-------|---------|
| `tokens.output` | Legacy count. Main-agent API calls plus whatever usage the Task tool reported for subagents. Undercounts subagent work whenever `toolUseResult` carries no `agentId`, which is always the case for Workflow agents. Semantics frozen so old transcripts stay comparable. |
| `tokens.dedupedOutput` | API-reported output tokens across main and subagent messages, deduplicated by `requestId`. The number shown as `out` in the status line. |
| `tokens.visibleOutput` | Estimated tokens you can actually read: characters of `text` blocks plus each tool call's name and JSON input, at 4 chars/token. Thinking blocks excluded. |
| `tokens.thinkingOutput` | API-reported thinking tokens from `output_tokens_details.thinking_tokens`, deduplicated by `requestId`, summed over the requests that report it. |
| `tokens.thinkingExact` | `true` when every request in the turn reported its thinking tokens, so `thinkingOutput` is complete. Subagent rows report it about 40% of the time, so turns with subagents are often `false`. |

When `thinkingExact` is `true`, the status line's `r` is `thinkingOutput` and `v` is `dedupedOutput - thinkingOutput`, both exact. Otherwise reasoning output is the residual, `dedupedOutput - visibleOutput`, which carries the 4-chars/token estimate's error alongside the thinking tokens. On one real 9,187-token turn the estimate put `v` at 3,674 against an exact 7,080.

`outputBySpeed` in the meta record splits `dedupedOutput` by each request's `usage.speed` (`standard`, or a fast-mode value), for requests that report one. It is absent when none does.

Assistant messages arrive as one JSONL line per content block. Those lines do not repeat the same `usage`: the intermediate ones carry a partial `output_tokens` and only the closing line carries the request's total, for example `1, 1, 1, 1, 276`. Both `dedupedOutput` and `visibleOutput` account for this. The first keeps one usage per `requestId`, the one with the largest `output_tokens`, which is the closing line. The second sums characters across lines and deduplicates only exact `uuid` repeats.

## Context Usage

The meta record carries a `contextWindow` object and, when the turn spawned subagents, a `subagentContext` array. Neither appears in the status line — a live statusline already shows context there; snoop's job is capturing it for later review.

```json
"contextWindow": {
  "used": 150010, "peak": 989865, "size": 1000000, "windowBasis": "model",
  "usedPercentage": 15, "peakPercentage": 99, "model": "claude-opus-5", "peakModel": "claude-opus-5",
  "compactThreshold": 967000, "headroom": 816990,
  "compactions": [{ "trigger": "auto", "preTokens": 998938, "postTokens": 32774, "droppedTokens": 966164 }]
},
"subagentContext": [
  { "agentId": "agent-bbb2", "peak": 367005, "size": 1000000, "peakPercentage": 37, "models": ["claude-sonnet-5"],
    "name": "Explore", "description": "Map the auth module", "spawnDepth": 1, "durationMs": 95376 }
]
```

Occupancy answers a different question from the token totals. `tokens.totalInput` is everything the session ever billed and only grows; `contextWindow.used` is how much of the window the conversation occupies at the end of the turn, and it *drops* when the session compacts. A long session can bill millions of tokens while occupying 90k. `peak` is the high-water mark, the only way to see how close a compacted session came to its limit, and each `compactions` entry records what one compaction discarded.

The count is exact — the same `input + cacheCreate + cacheRead` sum over the same message that Claude Code uses for its own context readout. The window size comes from the transcript too: `message.model` names the model, and snoop looks up that model's maximum input window (`windowBasis: "model"`). A model snoop does not list yet resolves to 1M once one of its own readings passes 200k (`observed`); until then `size` and the percentages are `null` (`unknown`) while the token counts stay exact. The window follows the model of the row being measured, so a `/model` switch mid-session is handled, and `peakModel` names the model the peak was measured on.

Each entry also carries the agent's `description` (its task label, which tells apart parallel agents of one type), `spawnDepth`, `isFork` for forked agents, and `durationMs` when the Agent result reports it. Workflow runs the capture touched appear in a top-level `workflows` array as `{ runId, workflowName }`.

Because subagents run their own windows, `subagentContext` readings are separate measurements rather than slices of the parent's — which is what makes a 367k Explore agent inside a 150k session traceable to the agent type and model that produced it.

Every captured message also carries its own footprint: `message.usage.context` is the window occupancy at that request, so the growth curve reads straight off the transcript. On a subagent row it reads against that agent's own window.

## Last Assistant Preview

When running on Claude Code 2.1.101+, the meta record includes a `lastAssistantPreview` field: a trimmed, single-line preview of the turn's final assistant message (up to 200 characters, with `…` suffix when truncated). Useful for quickly scanning transcripts in a list. Omitted when Claude Code didn't supply the data (older versions), and always omitted on `StopFailure` turns, which is how `/snoop:review` spots a failed turn.

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

JSONL. The first line is the meta record (`type: "meta"`, with the fields described above), then one message per line:

```json
{
  "type": "user|assistant",
  "timestamp": "ISO-8601",
  "uuid": "message-uuid",
  "parentUuid": "parent-uuid",
  "requestId": "req_...",
  "subagent": "agent-id",
  "message": {
    "role": "user|assistant",
    "model": "claude-sonnet-4-6",
    "content": "...",
    "usage": { "input": 10, "output": 5, "cacheRead": 100, "cacheCreate": 0, "cache5m": 0, "cache1h": 0, "context": 110 }
  }
}
```

`requestId` appears on assistant rows, `subagent` only on subagent rows, and `usage` only where the API reported it. Tool result text is truncated to 500 chars and image payloads are elided.

Interrupt markers are inserted where the user hit ESC:

```json
{
  "type": "interrupt",
  "marker": "═══════════════════ ⚠️ USER HIT ESC ═══════════════════",
  "timestamp": "ISO-8601"
}
```
