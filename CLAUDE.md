A Claude Code plugin that captures single-turn Claude Code transcripts for debugging and review. Transcripts are stored as JSONL files in `.claude/transcripts/` with metadata about tool usage, duration, and ESC interrupt detection.

## Development

To test locally:
```bash
claude --plugin-dir ~/projects/snoop
```

## Architecture

```
snoop/
├── .claude-plugin/plugin.json   # Plugin manifest
├── hooks/
│   ├── hooks.json               # Hook event bindings
│   └── capture-transcript.mjs   # Transcript capture hook
├── agents/
│   └── transcript-reviewer.md   # Review analysis agent
└── commands/
    └── review.md                # User command for transcript review
```

**Hook flow:**
- `UserPromptSubmit`: Detects ESC interrupts by checking for pending tool_use in last assistant message. Saves partial transcripts to `.partial_{session_id}.jsonl`.
- `Stop`: Merges any partials with final segment, writes complete transcript, updates `latest` pointer, cleans up old files (keeps 10).

**Transcript format:**
Each JSONL line contains `type`, `timestamp`, `uuid`, and `message` with role and content blocks. Tool results truncated to 500 chars. Interrupt markers inserted when ESC detected.

## Key Files

- `hooks/capture-transcript.mjs`: Transcript capture hook. Handles both hook events via `hook_event_name` field. Key functions: `handleUserPromptSubmit()`, `handleStop()`, `streamlineMessage()`.
- `agents/transcript-reviewer.md`: Defines the analysis methodology. Uses jq for large file surveys before targeted reads. Categorizes issues by severity (Critical/High/Medium/Low).
- `commands/review.md`: Entry point command. Resolves transcript file from args or `latest` pointer, delegates to reviewer agent.
