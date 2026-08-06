#!/bin/zsh
# Jamf policy script — installs the "Send to Claude Code" bridge for the logged-in user.
#
# Jamf runs policy scripts as root, but everything here belongs to the user: the clone
# lives in their home directory and the LaunchAgent runs in their GUI session. So the
# script figures out who is actually logged in and does all the work as them. Running
# any of this as root would create root-owned files in the user's home that they then
# can't update.
#
# Safe to run repeatedly — set it to recurring check-in so new hires get it automatically
# and existing installs stay current.
#
# Exit codes:  0 installed or already current
#              0 no console user (nobody logged in — Jamf retries next check-in)
#              1 a prerequisite is genuinely missing

REPO="https://github.com/maljaburi/FigmaToClaude.git"
APP_DIR_REL=".figma-to-claude/app"

# ---- who is actually at the keyboard ----------------------------------------
CONSOLE_USER=$(/usr/bin/stat -f%Su /dev/console)
if [ -z "$CONSOLE_USER" ] || [ "$CONSOLE_USER" = "root" ] || [ "$CONSOLE_USER" = "_mbsetupuser" ]; then
  echo "No console user logged in — nothing to do. Jamf will retry."
  exit 0
fi

USER_UID=$(/usr/bin/id -u "$CONSOLE_USER")
USER_HOME=$(/usr/bin/dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory | /usr/bin/awk '{print $2}')
APP_DIR="$USER_HOME/$APP_DIR_REL"
echo "User: $CONSOLE_USER ($USER_UID)  Home: $USER_HOME"

# Run a command as the console user, inside their GUI session so launchctl works.
as_user() {
  /bin/launchctl asuser "$USER_UID" /usr/bin/sudo -u "$CONSOLE_USER" /bin/zsh -lc "$1"
}

# ---- prerequisites ----------------------------------------------------------
# Homebrew's paths aren't on root's PATH, so look in the usual places explicitly.
NODE_BIN=$(as_user 'export PATH="$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; command -v node' 2>/dev/null)
if [ -z "$NODE_BIN" ]; then
  echo "ERROR: Node isn't installed for $CONSOLE_USER."
  echo "Scope a Node install policy ahead of this one, then re-run."
  exit 1
fi
echo "node: $NODE_BIN"

if [ ! -d "/Applications/Claude.app" ]; then
  # Not fatal: the bridge installs fine and the plugin reports the missing app clearly.
  echo "WARNING: Claude.app not found. The bridge will install, but sends won't open anything."
fi

# ---- clone or update --------------------------------------------------------
# Public repo, so this needs no credentials — which is the whole reason it can run
# from a root policy at all.
if [ -d "$APP_DIR/.git" ]; then
  echo "Updating existing clone…"
  as_user "cd '$APP_DIR' && git pull --ff-only --quiet" \
    || echo "WARNING: couldn't fast-forward (local edits?). Continuing with what's there."
else
  echo "Cloning…"
  as_user "mkdir -p '$(dirname "$APP_DIR")' && git clone --quiet '$REPO' '$APP_DIR'" \
    || { echo "ERROR: clone failed. Is $REPO public and reachable?"; exit 1; }
fi

as_user "chmod +x '$APP_DIR'/install.command '$APP_DIR'/bridge/*.command" 2>/dev/null

# ---- the LaunchAgent --------------------------------------------------------
echo "Installing the LaunchAgent…"
as_user "'$APP_DIR/bridge/autostart.command'" || { echo "ERROR: autostart failed."; exit 1; }

# ---- prove it, don't assume it ----------------------------------------------
for i in $(seq 1 15); do
  if as_user "curl -sf -m 2 http://localhost:7331/status >/dev/null"; then
    echo "OK: bridge is answering on localhost:7331"
    echo "Remaining, and only the user can do these:"
    echo "  1. Save the plugin from the org plugin list in Figma"
    echo "  2. Run /mcp in Claude Code once to authorize Figma"
    exit 0
  fi
  sleep 1
done

echo "ERROR: bridge didn't come up. See $USER_HOME/Library/Logs/figma-to-claude-bridge.log"
exit 1
