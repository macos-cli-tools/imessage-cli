# iMessage CLI — Claude Code Context

This file helps Claude Code understand and use the iMessage CLI effectively.

## Overview

Single-file TypeScript CLI (`imessage.ts`) providing 44 commands for macOS Messages.app.
Legacy bash script (`imessage.sh`) provides basic send/list/read/search (7 commands).

**Runtime:** [Bun](https://bun.sh) | **Platform:** macOS 12+ | **Database:** `~/Library/Messages/chat.db`

## Running Commands

```bash
# TypeScript (full feature set)
bun imessage.ts <command> [args...]

# Legacy bash (basic commands only)
bash imessage.sh <command> [args...]
```

## Full Disk Access Requirement

Commands that read the Messages database (`chat.db`) require Full Disk Access enabled for your terminal app in System Settings > Privacy & Security > Full Disk Access.

**No FDA needed:** `send`, `send-group`, `send-file`, `send-file-group`, `list`, `find`, `participants`, `groups`, `mark-read`, `delete-chat`, `create-group`, `leave-group`, `rename-group`, `block`, `unblock`, `blocked`, `spam-scan`, `report-spam`, `mute`, `unmute`, `forward`, `setup-fda`

**FDA required:** `read`, `thread-read`, `search`, `search-contact`, `reactions`, `export`, `contacts`, `threads`, `unread`, `info`, `stats`, `check-imessage`, `watch`, `build-index`, `semantic-search`, `list-attachments`, `get-attachment`, `archive-chat`, `delete-msg`

## Command Categories

### Send (no FDA)
- `send <phone|email> <message>` — Send 1:1 iMessage
- `send <phone|email> <message> --sms` — Force SMS (requires iPhone Continuity)
- `send-group <name> <message>` — Send to named group chat
- `send-file <phone|email> <path>` — Send file attachment
- `send-file-group <name> <path>` — Send file to group

### Navigate (no FDA)
- `list [N]` — Recent conversations with contact name resolution
- `find <handle>` — Find chats matching a phone/email
- `participants <name>` — List group members
- `groups [N]` — List group chats

### Database Interrogation (FDA)
- `contacts [N]` — Contacts ranked by message volume
- `threads [N]` — All conversations with unread counts
- `unread` — Conversations with unread messages
- `info <handle>` — Message stats for a contact
- `stats` — Global totals and top contacts

### Read & Search (FDA)
- `read <handle> [N] [--since --before]` — Last N messages (tab-separated)
- `thread-read <handle> [N] [--since]` — Formatted conversation view
- `search <query> [N] [--since --before --semantic --hybrid]` — Keyword/semantic search
- `semantic-search <query> [N]` — Vector similarity search
- `search-contact <name>` — Find contacts by handle pattern
- `reactions <handle> [N]` — List reactions in a conversation
- `export <handle> [--format md|txt]` — Export full conversation

### Attachments (FDA)
- `list-attachments <handle> [N]` — List with metadata
- `list-attachments <handle> --describe` — AI vision descriptions
- `get-attachment <id> [--out /dir]` — Download by ID

### Management
- `mark-read <handle>` — Mark conversation as read
- `archive-chat <handle>` — Archive conversation (FDA)
- `delete-msg <handle> <rowid>` — Delete one message (FDA)
- `delete-chat <handle>` — Delete conversation (GUI automation)
- `create-group <name> <h1> [h2...]` — Create group chat
- `leave-group <name>` / `rename-group <name> <new>`

### Block & Spam
- `blocked` — List blocked contacts
- `block <handle>` / `unblock <handle>` — Block management
- `spam-scan` — Heuristic spam detection with checklist output
- `report-spam <handle>` — Block + delete + report to Apple

### Alerts & Forwarding
- `mute <handle>` / `unmute <handle>` — Guided alert workflows
- `forward <handle> <rowid> <to>` — Forward message to another contact

### Watch & Detection
- `watch [<handle>] [--timeout N] [--json]` — Real-time message stream
- `check-imessage <handle>` — Check iMessage availability

### Semantic Search (FDA + OpenAI API key)
- `build-index [--incremental]` — Build embedding index
- `semantic-search <query> [N]` — Vector similarity search

## Key Flags

- `--json` — Machine-readable JSON output (all read commands)
- `--since <duration|date>` — Filter by time: `7d`, `2h`, `1w`, `3m`, or ISO date
- `--before <date>` — Upper time bound
- `--semantic` / `--hybrid` — Search modes (requires `build-index` first)

## State Directory

The CLI stores state in `~/.imessage-cli/`:
- `watch_state.json` — cursor for real-time watch
- `search_index.db` — semantic search embeddings
- `.env` — fallback for `OPENAI_API_KEY` (if not in environment)

## Known Limitations

1. **delete-msg iCloud sync** — Marks locally; iCloud propagation not guaranteed
2. **Group creation (macOS 13+)** — AppleScript unreliable; use Messages.app UI
3. **SMS send** — Requires iPhone Text Message Forwarding enabled
4. **Semantic search** — Requires OpenAI API key (`OPENAI_API_KEY` env var)
5. **Watch** — Uses kqueue via `fs.watch()` on chat.db + WAL files
