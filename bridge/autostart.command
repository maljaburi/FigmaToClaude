#!/bin/zsh
# Enable (or disable) auto-start of the Figma -> Claude Code bridge at login.
#
#   Double-click this file ........... enable auto-start (and start it now)
#   ./autostart.command uninstall .... disable and remove auto-start
#
# It installs a launchd LaunchAgent so the bridge always runs in the background.

LABEL="com.figma-to-claude.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
DOMAIN="gui/$(id -u)"

# Pick up the user's normal PATH (nvm / homebrew / official installer).
[ -f "$HOME/.zprofile" ] && source "$HOME/.zprofile" 2>/dev/null
[ -f "$HOME/.zshrc" ] && source "$HOME/.zshrc" 2>/dev/null
export PATH="$HOME/.local/bin:$HOME/.claude/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

unload() {
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || launchctl unload "$PLIST" 2>/dev/null || true
}

if [ "$1" = "uninstall" ]; then
  unload
  rm -f "$PLIST"
  echo "Auto-start disabled and removed."
  exit 0
fi

NODE="$(command -v node)"
if [ -z "$NODE" ]; then
  echo "Error: 'node' was not found on PATH. Install Node, then run this again."
  exit 1
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$BRIDGE_DIR/server.js</string>
  </array>
  <key>WorkingDirectory</key><string>$BRIDGE_DIR</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$HOME/.local/bin:$HOME/.claude/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/figma-to-claude-bridge.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/figma-to-claude-bridge.log</string>
</dict>
</plist>
PLIST_EOF

# (Re)load the agent. Try modern bootstrap first, fall back to legacy load.
unload
if launchctl bootstrap "$DOMAIN" "$PLIST" 2>/dev/null; then
  echo "Auto-start enabled (bootstrap)."
elif launchctl load -w "$PLIST" 2>/dev/null; then
  echo "Auto-start enabled (load)."
else
  echo "Could not load the LaunchAgent automatically. Plist written to:"
  echo "  $PLIST"
  echo "Log out and back in, or run:  launchctl load -w \"$PLIST\""
  exit 1
fi

launchctl kickstart -k "$DOMAIN/$LABEL" 2>/dev/null || true
echo "The bridge is now running and will start automatically at login."
echo "Log: ~/Library/Logs/figma-to-claude-bridge.log"
