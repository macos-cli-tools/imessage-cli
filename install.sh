#!/bin/bash
#
# iMessage CLI Installer
# Checks prerequisites, copies files, and sets up a shell alias.
#

set -euo pipefail

INSTALL_DIR="${HOME}/.imessage-cli"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "iMessage CLI — Installer"
echo "════════════════════════════════════════"
echo ""

# 1. Check macOS
if [[ "$(uname)" != "Darwin" ]]; then
  echo "ERROR: iMessage CLI requires macOS. Detected: $(uname)"
  exit 1
fi
echo "✓ macOS detected"

# 2. Check Bun
if ! command -v bun &> /dev/null; then
  echo ""
  echo "Bun is required but not installed."
  read -p "Install Bun now? [y/N] " -n 1 -r
  echo ""
  if [[ $REPLY =~ ^[Yy]$ ]]; then
    curl -fsSL https://bun.sh/install | bash
    export PATH="$HOME/.bun/bin:$PATH"
    echo "✓ Bun installed"
  else
    echo "Install Bun manually: curl -fsSL https://bun.sh/install | bash"
    exit 1
  fi
else
  echo "✓ Bun $(bun --version) found"
fi

# 3. Check Messages.app
if ! ls ~/Library/Messages/ &> /dev/null 2>&1; then
  echo "⚠ Messages.app directory not found — make sure you're signed into iMessage"
else
  echo "✓ Messages.app data found"
fi

# 4. Check Full Disk Access
if sqlite3 ~/Library/Messages/chat.db "SELECT 1;" &> /dev/null 2>&1; then
  echo "✓ Full Disk Access enabled (chat.db readable)"
else
  echo "⚠ Full Disk Access not enabled — read/search commands will not work"
  echo "  → System Settings → Privacy & Security → Full Disk Access → add your terminal"
  echo "  → Run 'bun imessage.ts setup-fda' for detailed instructions"
fi

# 5. Copy files
echo ""
echo "Installing to ${INSTALL_DIR}..."
mkdir -p "$INSTALL_DIR"
cp "$SCRIPT_DIR/imessage.ts" "$INSTALL_DIR/"
cp "$SCRIPT_DIR/imessage.sh" "$INSTALL_DIR/"
echo "✓ Files copied to ${INSTALL_DIR}"

# 6. Set up alias
SHELL_NAME="$(basename "$SHELL")"
case "$SHELL_NAME" in
  zsh)  RC_FILE="$HOME/.zshrc" ;;
  bash) RC_FILE="$HOME/.bashrc" ;;
  *)    RC_FILE="" ;;
esac

ALIAS_LINE="alias imsg=\"bun ${INSTALL_DIR}/imessage.ts\""

if [[ -n "$RC_FILE" ]]; then
  if grep -q "alias imsg=" "$RC_FILE" 2>/dev/null; then
    echo "✓ Alias 'imsg' already exists in ${RC_FILE}"
  else
    read -p "Add 'imsg' alias to ${RC_FILE}? [y/N] " -n 1 -r
    echo ""
    if [[ $REPLY =~ ^[Yy]$ ]]; then
      echo "" >> "$RC_FILE"
      echo "# iMessage CLI" >> "$RC_FILE"
      echo "$ALIAS_LINE" >> "$RC_FILE"
      echo "✓ Alias added. Run 'source ${RC_FILE}' or open a new terminal."
    else
      echo "  To add manually:"
      echo "  echo '${ALIAS_LINE}' >> ${RC_FILE}"
    fi
  fi
else
  echo "  Add this alias to your shell profile:"
  echo "  ${ALIAS_LINE}"
fi

# 7. Verify
echo ""
echo "════════════════════════════════════════"
echo "Installation complete!"
echo ""
echo "Quick test:"
echo "  bun ${INSTALL_DIR}/imessage.ts stats"
echo ""
echo "Or if alias was added:"
echo "  imsg stats"
echo "  imsg list 10"
echo "  imsg send +15551234567 \"Hello from the CLI!\""
