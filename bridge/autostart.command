#!/bin/zsh
# Enable (or disable) auto-start of the Figma -> Claude Code bridge at login.
#
#   Double-click this file ........... enable auto-start (and start it now)
#   ./autostart.command uninstall .... disable and remove auto-start
#
# It installs a launchd LaunchAgent so the bridge always runs in the background.
#
# Any of the bridge's configuration variables set in this shell are baked into the agent:
#
#   PORT PROTOTYPES_DIR PROJECT_ROOTS STANDARDS_URL BUILD_MODEL BUILD_EFFORT
#   SELF_UPDATE SKIP_AUTOSETUP
#
# e.g.  BUILD_MODEL=sonnet ./autostart.command
#
# A launchd agent does not inherit your shell environment, so anything not captured here
# is simply absent at login — which is why the list is written into the plist rather than
# left to the process to pick up.

LABEL="com.figma-to-claude.bridge"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BRIDGE_DIR="$(cd "$(dirname "$0")" && pwd)"
DOMAIN="gui/$(id -u)"
DEFAULT_PORT=7331

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

NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null)"
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  echo "Error: the bridge needs Node 18 or newer. Found: $("$NODE" --version 2>/dev/null)"
  echo "       Install a current Node, then run this again."
  exit 1
fi

# A version-manager path is valid today and gone the moment the user switches versions.
# launchd has no way to re-resolve it, so the agent would silently stop starting.
case "$NODE" in
  *"/.nvm/"*|*"/.fnm/"*|*"/.volta/"*|*"/n/versions/"*|*"/.asdf/"*)
    echo "Note: node is at"
    echo "        $NODE"
    echo "      which belongs to a version manager. If you switch or uninstall that"
    echo "      version, the bridge will stop starting at login — re-run this script"
    echo "      after changing your default Node."
    echo ""
    ;;
esac

# The plugin can only reach the port baked into plugin/manifest.json's allowedDomains,
# which Figma fixes at publish time. Moving the bridge without moving that leaves a
# perfectly healthy bridge that the panel reports as "not installed".
if [ -n "$PORT" ] && [ "$PORT" != "$DEFAULT_PORT" ]; then
  echo "Warning: PORT=$PORT, but the Figma plugin can only reach port $DEFAULT_PORT."
  echo "         That limit lives in plugin/manifest.json and is fixed when the plugin"
  echo "         is published. The bridge will start, but the panel will show it as"
  echo "         not installed. Re-publish the plugin if you really need another port."
  echo ""
fi

# The plist is XML: an ampersand or angle bracket in a path produces a file launchctl
# refuses, and the failure reads as "couldn't load the agent" with no clue why.
xml_escape() {
  printf '%s' "$1" | sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g'
}

CONFIG_KEYS=(PORT PROTOTYPES_DIR PROJECT_ROOTS STANDARDS_URL BUILD_MODEL BUILD_EFFORT SELF_UPDATE SKIP_AUTOSETUP)
EXTRA_ENV=""
CAPTURED=()
for key in $CONFIG_KEYS; do
  value="${(P)key}"
  if [ -n "$value" ]; then
    EXTRA_ENV+="    <key>$(xml_escape "$key")</key><string>$(xml_escape "$value")</string>"$'\n'
    CAPTURED+=("$key=$value")
  fi
done

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$(xml_escape "$LABEL")</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "$BRIDGE_DIR/server.js")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$BRIDGE_DIR")</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$(xml_escape "$HOME/.local/bin:$HOME/.claude/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin")</string>
$EXTRA_ENV  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$(xml_escape "$HOME/Library/Logs/figma-to-claude-bridge.log")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$HOME/Library/Logs/figma-to-claude-bridge.log")</string>
</dict>
</plist>
PLIST_EOF

# Catch a malformed plist here rather than as an opaque launchctl failure.
if ! plutil -lint "$PLIST" >/dev/null 2>&1; then
  echo "Error: the generated LaunchAgent isn't valid. This usually means a path contains"
  echo "       characters that couldn't be encoded. Plist left at:"
  echo "         $PLIST"
  plutil -lint "$PLIST"
  exit 1
fi

if [ ${#CAPTURED[@]} -gt 0 ]; then
  echo "Configuration baked into the agent:"
  for entry in $CAPTURED; do echo "  $entry"; done
  echo ""
fi

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

# No kickstart here. The agent sets RunAtLoad, so bootstrap has already started it on the
# new code — and `kickstart -k` would kill that fresh process, which launchd then refuses
# to respawn until its 10s ThrottleInterval elapses. That single redundant call was the
# entire "installing" pause: ten seconds of silence for work that was already done.

# Loading the agent is not the same as the bridge answering. Reporting success on the
# former meant a bridge that crashed on startup still printed "now running".
CHECK_PORT="${PORT:-$DEFAULT_PORT}"
LOG="$HOME/Library/Logs/figma-to-claude-bridge.log"

# This wait is normally 2-4 seconds and used to print nothing at all, which reads as a
# hang at the exact moment someone is deciding whether the installer is broken. The dots
# are the whole point: they say "still working" without claiming progress we can't measure.
printf "  waiting for it to answer"
for _ in $(seq 1 20); do
  if curl -fsS -m 1 "http://127.0.0.1:$CHECK_PORT/status" >/dev/null 2>&1; then
    printf " ready\n\n"
    echo "The bridge is answering on port $CHECK_PORT and will start automatically at login."
    echo "Log: $LOG"
    exit 0
  fi
  printf "."
  sleep 0.5
done
printf "\n"

echo ""
echo "The agent loaded, but nothing is answering on port $CHECK_PORT after 10 seconds."
echo "The last few log lines:"
echo ""
tail -n 15 "$LOG" 2>/dev/null | sed 's/^/  /'
echo ""
echo "Full log: $LOG"
exit 1
