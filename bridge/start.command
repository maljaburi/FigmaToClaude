#!/bin/zsh
# Double-click this file to start the Figma -> Claude Code bridge.
# It also auto-connects the Figma MCP to Claude Code on first run.
cd "$(dirname "$0")"
# Pick up the user's normal PATH (nvm, homebrew, official installer, etc.)
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null
export PATH="$HOME/.local/bin:$HOME/.claude/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
echo "Starting bridge…  (close this window to stop)"
exec node server.js
