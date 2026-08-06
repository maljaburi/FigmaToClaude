#!/bin/zsh
# One-step setup for a designer's Mac.
#
#   Paste this into Terminal:
#     git clone https://github.com/maljaburi/FigmaToClaude.git ~/.figma-to-claude/app \
#       && ~/.figma-to-claude/app/install.command
#
#   Already cloned? Just double-click this file. Re-running it updates to the latest.
#
# Installs a launchd agent so the bridge runs in the background from login onward, and
# tells you what to do in Figma. Run `bridge/autostart.command uninstall` to remove it.

# Deliberately no `set -e`. Sourcing a stranger's shell config below is a coin flip: a
# trailing `[ -s file ] && source file` that happens to be false makes the whole source
# return non-zero, and under errexit that kills this script silently before it prints a
# single line. Every step that actually matters checks its own result with `|| fail`.
APP_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$APP_DIR" || exit 1

# Pick up the user's normal PATH (nvm / homebrew / official installer), never fatally.
[ -f "$HOME/.zprofile" ] && { source "$HOME/.zprofile" >/dev/null 2>&1 || true; }
[ -f "$HOME/.zshrc" ] && { source "$HOME/.zshrc" >/dev/null 2>&1 || true; }
export PATH="$HOME/.local/bin:$HOME/.claude/bin:$HOME/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

say() { printf "\n\033[1m%s\033[0m\n" "$1"; }
fail() { printf "\n\033[31m%s\033[0m\n\n" "$1"; exit 1; }

say "Send to Claude Code — setup"
echo "Installing from: $APP_DIR"

# ---- prerequisites ----------------------------------------------------------
command -v node >/dev/null 2>&1 || fail \
"Node isn't installed.
Install it from https://nodejs.org (or 'brew install node'), then run this again."

command -v claude >/dev/null 2>&1 || echo \
"  Note: the 'claude' CLI wasn't found on PATH. The bridge still installs, but it can't
  auto-connect the Figma MCP until Claude Code is installed."

echo "  node    $(node --version)"
echo "  claude  $(claude --version 2>/dev/null || echo 'not found')"

# ---- update to the latest standards + code ----------------------------------
if [ -d .git ]; then
  echo "  updating from git…"
  # --ff-only so a designer's accidental local edit is reported, never silently lost.
  if ! git pull --ff-only --quiet 2>/dev/null; then
    echo "  (couldn't fast-forward — you may have local changes. Continuing with what's here.)"
  fi
  echo "  version $(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
fi

# ---- the bridge -------------------------------------------------------------
say "Starting the bridge"
./bridge/autostart.command >/dev/null || fail "Couldn't install the launchd agent."

# Give launchd a moment, then prove it's actually answering.
PORT="${PORT:-7331}"
for i in $(seq 1 15); do
  if curl -sf -m 2 "http://localhost:$PORT/status" >/dev/null 2>&1; then break; fi
  sleep 1
done

if curl -sf -m 2 "http://localhost:$PORT/status" >/dev/null 2>&1; then
  echo "  bridge is running on http://localhost:$PORT"
else
  fail "The bridge didn't come up. Check ~/Library/Logs/figma-to-claude-bridge.log"
fi

# ---- what's left, which is all in Figma -------------------------------------
say "Done. Two things left, both in Figma:"
cat <<STEPS

  1. Figma → Plugins → Development → Import plugin from manifest
     Choose:  $APP_DIR/plugin/manifest.json

  2. Select a frame, run the plugin, click Send to Claude Code.

  The first time you send, Claude Code may ask you to authorize Figma.
  Run /mcp in Claude Code once and approve it in the browser.

  For best results set the model to Opus 5 at Max effort in Claude Code.

STEPS
