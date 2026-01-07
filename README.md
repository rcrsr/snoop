# Snoop

Captures Claude Code single-turn transcripts for debugging and review.

## Features

- Captures complete single-turn transcripts as streamlined JSONL
- Detects ESC interrupts and marks them in the transcript
- Tracks tool usage, duration, and message counts
- Keeps last 10 transcripts, auto-cleans older ones
- Writes `latest` pointer for easy access to most recent transcript
- Includes review command and agent for transcript analysis

## Installation

### From Marketplace

Add the marketplace, then install the plugin:

```
/plugin marketplace add rcrsr/claude-plugins
/plugin install snoop@rcrsr
```

Optional scope flags:
- `--scope project` — install for all collaborators on this repo
- `--scope local` — install for yourself in this repo only

### Local Development

Launch Claude with the plugin directory:

```bash
claude --plugin-dir ~/projects/snoop
```

## Commands

| Command | Description |
|---------|-------------|
| `/snoop:review [file] [concern]` | Analyze single-turn transcript and generate review report |

## Agents

| Agent | Purpose |
|-------|---------|
| `transcript-reviewer` | Analyzes transcripts for behavioral issues and anti-patterns |

## Output

Transcripts are saved to `$CLAUDE_PROJECT_DIR/.claude/transcripts/`:

```
.claude/transcripts/
├── latest          # Pointer to most recent transcript
├── abc12345.jsonl  # Single-turn transcript
└── def67890.jsonl  # Previous transcript
```

## Hooks

| Event | Purpose |
|-------|---------|
| `UserPromptSubmit` | Detect ESC interrupts, save partial transcripts |
| `Stop` | Merge partials, capture complete transcript |

## Transcript Format

Each line is a JSON object with:

```json
{
  "type": "user|assistant|interrupt",
  "timestamp": "ISO-8601",
  "uuid": "message-uuid",
  "message": {
    "role": "user|assistant",
    "content": "string or content blocks"
  }
}
```

Interrupt markers appear when user hits ESC:

```json
{
  "type": "interrupt",
  "marker": "═══════════════════ ⚠️ USER HIT ESC ═══════════════════",
  "timestamp": "ISO-8601"
}
```

## Usage

### Review Latest Transcript

```
/snoop:review
```

### Review Specific Transcript

```
/snoop:review abc12345.jsonl
```

### Focus on Specific Concern

```
/snoop:review token usage
/snoop:review abc12345.jsonl policy compliance
```
