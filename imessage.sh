#!/bin/bash
#
# iMessage CLI v1.0.0 (Legacy)
# macOS Messages.app interface via AppleScript
# Requires: macOS 12+, Messages.app signed in to iMessage
# For 'read'/'search': Full Disk Access required in System Settings
#

VERSION="1.0.0"

# Escape a string for AppleScript double-quoted string literals
osa_str() {
    printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# ---------------------------------------------------------------------------
# USAGE
# ---------------------------------------------------------------------------
usage() {
    cat << EOF
iMessage CLI v${VERSION} — Command-line interface for macOS Messages.app

COMMANDS:
  send <to> <message>          Send iMessage to phone/email (1:1)
  send-group <name> <message>  Send to a named group chat
  list [N]                     List recent chats (default: 20)
  participants <name>          List participants of a named group chat
  find <phone|email>           Find chats matching a handle
  read <phone|email> [N]       Read last N messages (requires Full Disk Access)
  search <query> [N]           Search all messages (requires Full Disk Access)
  setup-fda                    Print instructions to enable Full Disk Access

OPTIONS:
  --help                       Show this help

EXAMPLES:
  imessage.sh send +15551234567 "Hey, are you free?"
  imessage.sh send friend@example.com "On my way home"
  imessage.sh send-group "Family Chat" "Dinner at 7?"
  imessage.sh list 10
  imessage.sh participants "Family Chat"
  imessage.sh read +15551234567 5
  imessage.sh search "dinner" 20

NOTES:
  - For 1:1 send, <to> can be: +1XXXXXXXXXX or email@example.com
  - Group send uses chat name (partial match not supported — exact name)
  - Read/search require Full Disk Access for Terminal/Claude Code
    Run: imessage.sh setup-fda   for instructions
EOF
}

# ---------------------------------------------------------------------------
# SEND (1:1)
# ---------------------------------------------------------------------------
cmd_send() {
    local to="$1"
    local msg="$2"

    if [[ -z "$to" || -z "$msg" ]]; then
        echo "ERROR: Usage: send <phone|email> <message>" >&2
        exit 1
    fi

    local to_esc msg_esc
    to_esc=$(osa_str "$to")
    msg_esc=$(osa_str "$msg")

    local result
    result=$(osascript << EOF
tell application "Messages"
    set acct to first account whose service type is iMessage
    set b to buddy "${to_esc}" of acct
    send "${msg_esc}" to b
    return "sent"
end tell
EOF
)

    if [[ "$result" == "sent" ]]; then
        echo "✓ Sent to ${to}"
    else
        echo "ERROR: Send failed — ${result}" >&2
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# SEND-GROUP
# ---------------------------------------------------------------------------
cmd_send_group() {
    local name="$1"
    local msg="$2"

    if [[ -z "$name" || -z "$msg" ]]; then
        echo "ERROR: Usage: send-group <chat-name> <message>" >&2
        exit 1
    fi

    local name_esc msg_esc
    name_esc=$(osa_str "$name")
    msg_esc=$(osa_str "$msg")

    local result
    result=$(osascript << EOF
tell application "Messages"
    try
        set c to first chat whose name is "${name_esc}"
        send "${msg_esc}" to c
        return "sent"
    on error errMsg
        return "ERROR: " & errMsg
    end try
end tell
EOF
)

    if [[ "$result" == "sent" ]]; then
        echo "✓ Sent to group '${name}'"
    else
        echo "ERROR: ${result}" >&2
        exit 1
    fi
}

# ---------------------------------------------------------------------------
# LIST CHATS
# ---------------------------------------------------------------------------
cmd_list() {
    local limit="${1:-20}"

    osascript << EOF
tell application "Messages"
    set output to {}
    set allChats to every chat
    set total to count of allChats
    set endIdx to ${limit}
    if endIdx > total then set endIdx to total
    repeat with i from 1 to endIdx
        set c to item i of allChats
        set cid to id of c
        -- Get name, handle missing value gracefully
        set cname to ""
        try
            set rawName to name of c
            if rawName is not missing value then
                set cname to rawName as string
            end if
        end try
        -- Count participants
        set pCount to count of (participants of c)
        -- Detect 1:1 vs group
        if pCount > 2 then
            set chatType to "group(" & pCount & ")"
        else
            set chatType to "1:1"
        end if
        -- For unnamed chats, extract handle from chat ID (format: any;-;HANDLE)
        if cname is "" then
            set AppleScript's text item delimiters to ";"
            set parts to text items of cid
            set AppleScript's text item delimiters to ""
            if (count of parts) >= 3 then
                set cname to item 3 of parts
            else
                set cname to cid
            end if
        end if
        set end of output to ("[" & chatType & "] " & cname)
    end repeat
    set AppleScript's text item delimiters to linefeed
    set outputStr to output as string
    set AppleScript's text item delimiters to ""
    return outputStr
end tell
EOF
}

# ---------------------------------------------------------------------------
# PARTICIPANTS
# ---------------------------------------------------------------------------
cmd_participants() {
    local name="$1"

    if [[ -z "$name" ]]; then
        echo "ERROR: Usage: participants <chat-name>" >&2
        exit 1
    fi

    local name_esc
    name_esc=$(osa_str "$name")

    osascript << EOF
tell application "Messages"
    try
        set c to first chat whose name is "${name_esc}"
        set pList to {}
        repeat with p in participants of c
            set h to handle of p
            try
                set fn to full name of p
                set end of pList to (fn & " <" & h & ">")
            on error
                set end of pList to h
            end try
        end repeat
        set AppleScript's text item delimiters to linefeed
        set outputStr to pList as string
        set AppleScript's text item delimiters to ""
        return outputStr
    on error errMsg
        return "ERROR: " & errMsg
    end try
end tell
EOF
}

# ---------------------------------------------------------------------------
# FIND — find chats matching a handle
# ---------------------------------------------------------------------------
cmd_find() {
    local handle="$1"

    if [[ -z "$handle" ]]; then
        echo "ERROR: Usage: find <phone|email>" >&2
        exit 1
    fi

    local handle_esc
    handle_esc=$(osa_str "$handle")

    osascript << EOF
tell application "Messages"
    set results to {}
    repeat with c in chats
        set cid to id of c
        if cid contains "${handle_esc}" then
            try
                set cname to name of c
            on error
                set cname to cid
            end try
            set end of results to ("id=" & cid & " name=" & cname)
        end if
    end repeat
    if (count of results) = 0 then
        return "No chats found for: ${handle_esc}"
    end if
    set AppleScript's text item delimiters to linefeed
    set outputStr to results as string
    set AppleScript's text item delimiters to ""
    return outputStr
end tell
EOF
}

# ---------------------------------------------------------------------------
# READ — requires Full Disk Access
# ---------------------------------------------------------------------------
cmd_read() {
    local handle="$1"
    local limit="${2:-10}"

    if [[ -z "$handle" ]]; then
        echo "ERROR: Usage: read <phone|email> [limit]" >&2
        exit 1
    fi

    local db="$HOME/Library/Messages/chat.db"

    if ! sqlite3 "$db" "SELECT 1;" > /dev/null 2>&1; then
        cat << 'EOF'
ERROR: Cannot read chat.db — Full Disk Access required.

To enable:
  1. System Settings → Privacy & Security → Full Disk Access
  2. Add Terminal (or the app running Claude Code)
  3. Restart Terminal
  4. Run: imessage.sh setup-fda  for detailed instructions

Alternatively, install imessage-exporter:
  brew install imessage-exporter
EOF
        exit 1
    fi

    # Normalize handle: strip spaces, ensure + prefix for phone numbers
    # Escape single quotes to prevent SQL injection
    local h
    h=$(printf '%s' "$handle" | sed "s/'/''/g")

    sqlite3 -separator $'\t' "$db" << SQL
SELECT
    datetime(m.date/1000000000 + strftime('%s','2001-01-01'), 'unixepoch', 'localtime') AS sent_at,
    CASE m.is_from_me WHEN 1 THEN 'me' ELSE COALESCE(h.id, 'them') END AS sender,
    REPLACE(REPLACE(m.text, CHAR(10), ' '), CHAR(13), ' ') AS body
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
JOIN chat_handle_join chj ON chj.chat_id = c.ROWID
JOIN handle h ON h.ROWID = chj.handle_id
WHERE (h.id = '${h}' OR c.chat_identifier = '${h}')
  AND m.text IS NOT NULL
  AND m.text != ''
ORDER BY m.date DESC
LIMIT ${limit};
SQL
}

# ---------------------------------------------------------------------------
# SEARCH — requires Full Disk Access
# ---------------------------------------------------------------------------
cmd_search() {
    local query="$1"
    local limit="${2:-20}"

    if [[ -z "$query" ]]; then
        echo "ERROR: Usage: search <text> [limit]" >&2
        exit 1
    fi

    local db="$HOME/Library/Messages/chat.db"

    if ! sqlite3 "$db" "SELECT 1;" > /dev/null 2>&1; then
        echo "ERROR: Cannot access chat.db — Full Disk Access required."
        echo "Run: imessage.sh setup-fda"
        exit 1
    fi

    local q_esc
    q_esc=$(printf '%s' "$query" | sed "s/'/''/g")

    sqlite3 -separator $'\t' "$db" << SQL
SELECT
    datetime(m.date/1000000000 + strftime('%s','2001-01-01'), 'unixepoch', 'localtime') AS sent_at,
    COALESCE(h.id, 'me') AS sender,
    c.chat_identifier AS chat,
    REPLACE(REPLACE(m.text, CHAR(10), ' '), CHAR(13), ' ') AS body
FROM message m
JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
JOIN chat c ON c.ROWID = cmj.chat_id
LEFT JOIN handle h ON h.ROWID = m.handle_id
WHERE m.text LIKE '%${q_esc}%'
  AND m.text IS NOT NULL
ORDER BY m.date DESC
LIMIT ${limit};
SQL
}

# ---------------------------------------------------------------------------
# SETUP-FDA instructions
# ---------------------------------------------------------------------------
cmd_setup_fda() {
    cat << 'EOF'
=== Full Disk Access — Setup Instructions ===

Full Disk Access is required to read/search iMessages (chat.db).

STEP 1: Open System Settings
  → Privacy & Security → Full Disk Access

STEP 2: Add your terminal app. Common options:
  - Terminal.app (built-in)
  - iTerm2
  - Ghostty
  - Your IDE terminal (VS Code, Cursor, etc.)

STEP 3: If using Claude Code (claude CLI):
  Add the claude binary or its parent terminal to Full Disk Access.

STEP 4: Restart the terminal app.

STEP 5: Verify access:
  sqlite3 ~/Library/Messages/chat.db "SELECT count(*) FROM message;"
  → Should return a number, not "authorization denied"

ALTERNATIVE — imessage-exporter (no FDA required for some exports):
  brew install imessage-exporter
  imessage-exporter -f txt -o ~/messages-export/
EOF
}

# ---------------------------------------------------------------------------
# MAIN DISPATCH
# ---------------------------------------------------------------------------
CMD="${1}"
shift || true

case "$CMD" in
    send)            cmd_send "$@" ;;
    send-group)      cmd_send_group "$@" ;;
    list)            cmd_list "$@" ;;
    participants)    cmd_participants "$@" ;;
    find)            cmd_find "$@" ;;
    read)            cmd_read "$@" ;;
    search)          cmd_search "$@" ;;
    setup-fda)       cmd_setup_fda ;;
    --help|help|-h|"") usage ;;
    *)
        echo "ERROR: Unknown command '${CMD}'" >&2
        echo "Run: imessage.sh --help" >&2
        exit 1
        ;;
esac
