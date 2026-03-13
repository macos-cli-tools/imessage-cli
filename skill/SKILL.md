---
name: iMessage
description: >
  Send and receive iMessages via macOS Messages.app. USE WHEN user wants to
  send iMessage, text someone, read texts, search messages, find contacts,
  list unread, manage groups, handle attachments, or interact with Messages.app.
---

# iMessage Skill

Bun-based TypeScript CLI + AppleScript + SQLite interface to macOS Messages.app.

**Primary script:** `INSTALL_DIR/imessage.ts`
**Legacy script:** `INSTALL_DIR/imessage.sh` (v1.0.0, still works)
**Requires:** Bun, macOS 12+, Messages.app signed into iMessage

> **Setup:** Replace `INSTALL_DIR` above (and in examples below) with the actual
> path where you cloned the repository. For example: `~/Projects/imessage-cli`

## Quick Reference

```bash
# Set this to your clone location
IMSG="bun INSTALL_DIR/imessage.ts"

# Send
$IMSG send +15551234567 "Hello!"
$IMSG send-group "Family Chat" "Dinner at 7?"
$IMSG send-file +15551234567 ~/photo.jpg

# Read & search (requires Full Disk Access)
$IMSG list 20                              # recent conversations
$IMSG thread-read +15551234567 20          # formatted conversation
$IMSG read +15551234567 10 --since 7d      # last 7 days
$IMSG search "dinner" 20                   # keyword search
$IMSG unread                               # unread conversations

# Database stats
$IMSG stats                                # global totals
$IMSG contacts 50                          # top contacts by volume
$IMSG info +15551234567                    # per-contact stats

# Manage
$IMSG mark-read +15551234567
$IMSG spam-scan                            # heuristic spam detection
$IMSG block +15551234567
$IMSG watch --timeout 60                   # real-time message stream

# Export
$IMSG export +15551234567 --format md > chat.md

# JSON output (all read commands)
$IMSG threads 10 --json
```

## Full Disk Access

**Not required:** send, send-group, send-file, send-file-group, list, find, participants, groups, mark-read, delete-chat, create-group, leave-group, rename-group, block, unblock, blocked, spam-scan, report-spam, mute, unmute, forward, setup-fda

**Required:** read, thread-read, search, search-contact, reactions, export, contacts, threads, unread, info, stats, check-imessage, watch, build-index, semantic-search, list-attachments, get-attachment, archive-chat, delete-msg

Run `setup-fda` for instructions on enabling Full Disk Access.

## Time Filters

```bash
$IMSG read +15551234567 50 --since 7d           # relative duration
$IMSG search "meeting" --since 2026-01-01        # ISO date
$IMSG thread-read +15551234567 --since 2h        # hours
$IMSG search "food" --since 1w --before 2026-03-01  # date range
```

Formats: `Nd` (days), `Nh` (hours), `Nw` (weeks), `Nm` (months), ISO dates

## Semantic Search

Requires OpenAI API key (`OPENAI_API_KEY` environment variable):

```bash
$IMSG build-index                                 # one-time index build
$IMSG semantic-search "dinner plans" 5            # vector similarity
$IMSG search "food" 10 --hybrid                   # keyword + vector
$IMSG search "food" 10 --semantic                 # vector only
```

## Known Limitations

1. **Read/search/DB commands require Full Disk Access** for chat.db
2. **delete-msg**: Marks locally; iCloud sync propagation not guaranteed
3. **Group creation (macOS 13+)**: AppleScript unreliable; use Messages.app UI
4. **Block management**: No public API; commands guide to Messages.app UI
5. **SMS send**: Requires iPhone Text Message Forwarding enabled
6. **Semantic search**: Requires `build-index` first (one-time, uses OpenAI API)
7. **Watch**: Uses kqueue via `fs.watch()` on chat.db + WAL files
