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
# `dscl -read` prints "NFSHomeDirectory: /Users/some name", so awk '{print $2}' silently
# truncates at the first space. Take everything after the colon instead, then verify it —
# a wrong home directory here installs the whole thing somewhere nobody will find it.
USER_HOME=$(/usr/bin/dscl . -read "/Users/$CONSOLE_USER" NFSHomeDirectory 2>/dev/null | /usr/bin/sed -n 's/^NFSHomeDirectory: //p')
if [ -z "$USER_HOME" ] || [ ! -d "$USER_HOME" ]; then
  echo "ERROR: couldn't resolve a home directory for $CONSOLE_USER (got: '$USER_HOME')."
  exit 1
fi
# Everything below is interpolated into shell command strings for `zsh -lc`. A quote or a
# dollar sign in the path would change what those commands mean, so refuse up front.
case "$USER_HOME" in
  *[\'\"\$\`\\]*)
    echo "ERROR: home directory contains characters this script can't quote safely: $USER_HOME"
    exit 1
    ;;
esac
APP_DIR="$USER_HOME/$APP_DIR_REL"
echo "User: $CONSOLE_USER ($USER_UID)  Home: $USER_HOME"

# Run a command as the console user, inside their GUI session so launchctl works.
# `sudo -u` runs before this string is evaluated, so everything here runs as the user.
as_user() {
  /bin/launchctl asuser "$USER_UID" /usr/bin/sudo -u "$CONSOLE_USER" /bin/zsh -lc "$1"
}

# ---- prerequisites ----------------------------------------------------------
# `zsh -lc` sources .zshenv and .zprofile but NOT .zshrc, which is where nvm and fnm
# usually put their shims — so this must add the same directories autostart.command does,
# or a machine that installs the bridge fine fails the Node check here.
USER_PATH_PREFIX='export PATH="$HOME/.local/bin:$HOME/.claude/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH";'

for tool in git curl node; do
  if ! as_user "$USER_PATH_PREFIX command -v $tool >/dev/null 2>&1"; then
    echo "ERROR: '$tool' isn't available for $CONSOLE_USER."
    [ "$tool" = "node" ] && echo "Scope a Node install policy ahead of this one, then re-run."
    exit 1
  fi
done

NODE_BIN=$(as_user "$USER_PATH_PREFIX command -v node" 2>/dev/null)
NODE_MAJOR=$(as_user "$USER_PATH_PREFIX node -p 'process.versions.node.split(\".\")[0]'" 2>/dev/null)
if [ -z "$NODE_MAJOR" ] || [ "$NODE_MAJOR" -lt 18 ]; then
  echo "ERROR: the bridge needs Node 18 or newer. $CONSOLE_USER has: $(as_user "$USER_PATH_PREFIX node --version" 2>/dev/null)"
  exit 1
fi
echo "node: $NODE_BIN (major $NODE_MAJOR)"

# Check both locations the bridge itself checks, or a per-user install reads as missing.
if [ ! -d "/Applications/Claude.app" ] && [ ! -d "$USER_HOME/Applications/Claude.app" ]; then
  # Not fatal: the bridge installs fine and the plugin reports the missing app clearly.
  echo "WARNING: Claude.app not found. The bridge will install, but sends won't open anything."
fi

# ---- clone or update --------------------------------------------------------
# Public repo, so this needs no credentials — which is the whole reason it can run
# from a root policy at all.
#
# CHANNEL is the branch a fleet machine follows. `main` is where work lands; `release` is
# moved deliberately, so a push doesn't reach every Mac in the org the moment it happens.
# Falls back to the repo's default branch when the channel hasn't been cut yet, and the
# bridge moves the clone across on its own once it has.
CHANNEL="${UPDATE_CHANNEL:-release}"

if [ -d "$APP_DIR/.git" ]; then
  echo "Updating existing clone…"
  as_user "cd '$APP_DIR' && git pull --ff-only --quiet" \
    || echo "WARNING: couldn't fast-forward (local edits?). Continuing with what's there."
else
  # Asked before cloning rather than cloning and falling back: `clone --branch` on a branch
  # that isn't there fails after creating the directory, and whether it tidies up is not
  # something a fleet install should be betting on.
  BRANCH_ARG=""
  if as_user "git ls-remote --exit-code --heads '$REPO' '$CHANNEL'" >/dev/null 2>&1; then
    BRANCH_ARG="--branch $CHANNEL"
    echo "Cloning ($CHANNEL)…"
  else
    echo "Cloning (no $CHANNEL branch yet — taking the default)…"
  fi
  as_user "mkdir -p '$(dirname "$APP_DIR")' && git clone --quiet $BRANCH_ARG '$REPO' '$APP_DIR'" \
    || { echo "ERROR: clone failed. Is $REPO public and reachable?"; exit 1; }
fi

as_user "chmod +x '$APP_DIR'/install.command '$APP_DIR'/bridge/*.command" 2>/dev/null

# ---- the LaunchAgent --------------------------------------------------------
echo "Installing the LaunchAgent…"
as_user "'$APP_DIR/bridge/autostart.command'" || { echo "ERROR: autostart failed."; exit 1; }

# ---- prove it, don't assume it ----------------------------------------------
# 7331 is fixed: it's what plugin/manifest.json's allowedDomains permits, and Figma
# freezes that at publish time.
for i in $(seq 1 15); do
  if as_user "curl -sf -m 2 http://127.0.0.1:7331/status >/dev/null"; then
    echo "OK: bridge is answering on 127.0.0.1:7331"
    echo "Remaining, and only the user can do these:"
    echo "  1. Save the plugin from the org plugin list in Figma"
    echo "  2. Run /mcp in Claude Code once to authorize Figma"
    exit 0
  fi
  sleep 1
done

# The log is the only thing that says why, and nobody is going to read it on the user's
# machine — so put it in the Jamf policy output where whoever ran this will see it.
echo "ERROR: bridge didn't come up within 15 seconds. Last log lines:"
as_user "tail -n 20 '$USER_HOME/Library/Logs/figma-to-claude-bridge.log' 2>/dev/null" | /usr/bin/sed 's/^/  /'
echo "Full log: $USER_HOME/Library/Logs/figma-to-claude-bridge.log"
exit 1
