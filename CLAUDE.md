# snoop

Captures run transcripts for debugging and review. Stores JSONL files in `.claude/transcripts/`.

## Development

```bash
claude --plugin-dir /path/to/snoop
```

## Architecture

```
hooks/
└── hooks.json               # UserPromptSubmit + Stop bindings
scripts/
└── capture-transcript.mjs   # Dual-purpose hook handler
agents/
└── transcript-reviewer.md   # Post-mortem analysis agent
commands/
└── review.md                # /snoop:review - analyze transcript
```

## Hook Flow

| Event | Behavior |
|-------|----------|
| `UserPromptSubmit` | Detects ESC interrupts (pending tool_use). Saves partial to `.partial_{session_id}.jsonl` |
| `Stop` | Merges partials, writes complete transcript, updates `latest` pointer, keeps 10 files |

## Key Files

| File | Responsibility |
|------|----------------|
| `scripts/capture-transcript.mjs` | Core hook. Routes via `hook_event_name`. Key functions: `handleUserPromptSubmit()`, `handleStop()`, `streamlineMessage()` |
| `agents/transcript-reviewer.md` | Analysis methodology. Uses jq for surveys, categorizes issues by severity |
| `commands/review.md` | Entry point. Resolves transcript from args or `latest` pointer |

## Transcript Format

JSONL with one message per line:

| Field | Content |
|-------|---------|
| `type` | `user`, `assistant`, or `interrupt` |
| `timestamp` | ISO timestamp |
| `message.content` | Array of blocks (tool_use, tool_result, text, thinking) |

Tool results truncated to 500 chars. Interrupt markers inserted on ESC.
