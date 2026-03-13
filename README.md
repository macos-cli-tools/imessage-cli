# iMessage Complete CLI

A comprehensive command-line interface for macOS Messages.app — 44 commands for sending, reading, searching, managing, and interrogating the iMessage database.

Built with [Bun](https://bun.sh) and TypeScript. Zero external dependencies beyond Bun's built-in SQLite.

## Requirements

- **macOS 12+** (Monterey or later)
- **[Bun](https://bun.sh)** runtime (`curl -fsSL https://bun.sh/install | bash`)
- **Messages.app** signed into iMessage
- **Full Disk Access** (for database read commands) — System Settings → Privacy & Security → Full Disk Access → add your terminal app

## Quick Start

```bash
# Run any command
bun imessage.ts <command> [args...]

# Create a convenient alias
alias imsg="bun /path/to/imessage.ts"

# Check your stats
imsg stats

# List recent conversations (with contact name resolution)
imsg list 20

# Read last 10 messages from a contact
imsg read +15551234567 10

# Send a message
imsg send +15551234567 "Hello from the CLI!"

# Search all messages
imsg search "dinner plans" 20

# Check for spam
imsg spam-scan
```

## Commands (44 total)

### Send
| Command | Description |
|---------|-------------|
| `send <to> <msg>` | Send iMessage to phone/email |
| `send <to> <msg> --sms` | Force SMS (requires iPhone Continuity) |
| `send-group <name> <msg>` | Send to named group chat |
| `send-file <to> <path>` | Send file attachment 1:1 |
| `send-file-group <name> <path>` | Send file to group |

### Navigate
| Command | Description |
|---------|-------------|
| `list [N]` | Recent conversations with contact names |
| `find <handle>` | Find chats for a phone/email |
| `participants <name>` | List group members |
| `groups [N]` | List group chats |

### Database Interrogation
| Command | Description |
|---------|-------------|
| `contacts [N]` | Contacts ranked by message volume |
| `threads [N]` | All conversations with unread counts |
| `unread` | Conversations with unread messages |
| `info <handle>` | Message stats for a contact |
| `stats` | Global totals and top contacts |

### Read & Search
| Command | Description |
|---------|-------------|
| `read <handle> [N]` | Last N messages (raw) |
| `thread-read <handle> [N]` | Formatted conversation view |
| `search <query> [N]` | Keyword search |
| `search <query> --semantic` | Semantic search (requires index) |
| `search <query> --hybrid` | Hybrid keyword + semantic |
| `search-contact <name>` | Find contacts by handle pattern |
| `reactions <handle> [N]` | List reactions in conversation |
| `export <handle> [--format md\|txt]` | Export full conversation |

### Attachments
| Command | Description |
|---------|-------------|
| `list-attachments <handle> [N]` | List attachments with metadata |
| `list-attachments <handle> --describe` | AI vision descriptions |
| `get-attachment <id> [--out /dir]` | Download attachment by ID |

### Management
| Command | Description |
|---------|-------------|
| `mark-read <handle>` | Mark conversation as read |
| `archive-chat <handle>` | Archive conversation |
| `delete-msg <handle> <rowid>` | Delete one message (guided) |
| `delete-chat <handle>` | Delete conversation (automated GUI) |
| `create-group <name> <h1> [h2...]` | Create group chat |
| `leave-group <name>` | Leave group chat |
| `rename-group <name> <new>` | Rename group chat |

### Block & Spam
| Command | Description |
|---------|-------------|
| `blocked` | List blocked contacts |
| `block <handle>` | Block via GUI scripting |
| `unblock <handle>` | Guided unblock workflow |
| `spam-scan` | Heuristic spam detection with checklist output |
| `report-spam <handle>` | Block + delete + report to Apple |

### Alerts & Forwarding
| Command | Description |
|---------|-------------|
| `mute <handle>` | Guided mute workflow |
| `unmute <handle>` | Guided unmute workflow |
| `forward <handle> <rowid> <to>` | Forward message to another contact |

### Watch & Detection
| Command | Description |
|---------|-------------|
| `watch [<handle>] [--timeout N]` | Real-time message stream (kqueue) |
| `check-imessage <handle>` | Check iMessage availability |

### Semantic Search
| Command | Description |
|---------|-------------|
| `build-index [--incremental]` | Build embedding index (OpenAI) |
| `semantic-search <query> [N]` | Vector similarity search |

### Setup
| Command | Description |
|---------|-------------|
| `setup-fda` | Full Disk Access setup guide |

## Time Filters

`read`, `thread-read`, and `search` support `--since` and `--before` flags:

```bash
imsg read +15551234567 50 --since 7d          # Last 7 days
imsg search "meeting" --since 2026-01-01      # Since a specific date
imsg thread-read +15551234567 --since 2h      # Last 2 hours
```

Formats: ISO dates (`2026-01-01`), relative (`7d`, `2h`, `1w`, `3m`)

## JSON Output

Add `--json` to any read command for structured JSON output:

```bash
imsg threads 10 --json
imsg read +15551234567 5 --json
imsg watch --json --timeout 30
```

## Spam Scanner

The `spam-scan` command uses heuristic scoring to identify likely spam:

- Philippines (+63) numbers, suspicious email domains
- Job scam keywords ($X00/day, WhatsApp, TEMU, remote job)
- Phishing patterns (FedEx, DMV, verification code)
- One-way conversations (never replied)

Outputs a Markdown checklist file. Review and check items, then use `report-spam` on confirmed spam.

## Contact Name Resolution

`list` automatically resolves phone numbers to contact names by reading your macOS AddressBook SQLite databases. Works with thousands of contacts (no AppleScript overhead).

## Known Limitations

- **mute/unmute**: macOS prevents System Events from toggling alert state — guided workflow only
- **unblock**: Messages.app has no "Unblock" menu item — must use Settings → Blocked
- **delete-msg/archive-chat**: macOS SIP blocks direct chat.db writes — guided workflow
- **block**: May fail on conversations that were already deleted (no confirmation sheet appears)
- **SMS send**: Requires iPhone Text Message Forwarding enabled on your iPhone
- **Semantic search**: Requires OpenAI API key in environment (`OPENAI_API_KEY`)

## Architecture

Single TypeScript file (~2,800 lines), no build step. Uses:
- `bun:sqlite` for direct chat.db queries
- `osascript` (AppleScript) for Messages.app interaction
- macOS System Events for GUI automation (block, delete)
- AddressBook SQLite for contact resolution
- kqueue (via `fs.watch`) for real-time message watching
- OpenAI API for semantic search embeddings (optional)

## Legacy Script

`imessage.sh` is the original bash script (v1.0.0) with basic send/list/read/search/find. Retained for backward compatibility.

## License

MIT
