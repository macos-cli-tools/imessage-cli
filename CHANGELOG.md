# Changelog

All notable changes to iMessage CLI are documented here.

## v2.2.0 — 2026-03-13

**Spam Management & Quality of Life**

- Added `spam-scan` — heuristic spam detection with scored checklist output
- Added `report-spam` — combo block + delete + Apple spam report
- Added `mute` / `unmute` — guided alert toggle workflows
- Added `forward` — message forwarding by ROWID
- Upgraded `delete-chat` — fully automated GUI scripting
- Upgraded `list` — contact name resolution via AddressBook SQLite (instant, handles thousands of contacts)
- Upgraded `blocked` — now parses email blocks in addition to phone numbers
- **44 commands total**

## v2.1.0 — 2026-03-12

**Gap Closure**

- Added `--since` / `--before` time filters on `read`, `thread-read`, and `search`
- Added `check-imessage` — detect iMessage vs SMS for a handle
- Added `send --sms` — force SMS delivery (requires iPhone Continuity)
- Added `watch` — real-time message stream via kqueue file watching
- Added `build-index` — OpenAI embedding index for semantic search
- Added `semantic-search` and `search --semantic` / `--hybrid` modes
- **38 commands total**

## v2.0.0 — 2026-03-06

**Full TypeScript Rewrite**

Complete rewrite from bash to Bun TypeScript. Zero external dependencies.

- Added 27 new commands: `contacts`, `threads`, `unread`, `info`, `stats`, `send-file`, `send-file-group`, `list-attachments`, `get-attachment`, `reactions`, `thread-read`, `export`, `search-contact`, `mark-read`, `delete-msg`, `delete-chat`, `archive-chat`, `groups`, `create-group`, `leave-group`, `rename-group`, `block`, `unblock`, `blocked`
- JSON output via `--json` flag on all read commands
- Direct SQLite queries via `bun:sqlite` (replaces shell sqlite3)
- AddressBook contact resolution (replaces slow AppleScript)
- Legacy `imessage.sh` retained for backward compatibility
- **32 commands total**

## v1.0.0 — 2026-03-06

**Initial Release (Bash)**

- `send` — send iMessage to phone/email
- `send-group` — send to named group chat
- `list` — list recent conversations
- `participants` — list group members
- `find` — find chats by handle
- `read` — read messages (requires Full Disk Access)
- `search` — search all messages (requires Full Disk Access)
- **7 commands total**
