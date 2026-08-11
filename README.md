# Send to Claude Code

A Figma plugin that turns the selected frames into built screens. Designer selects frames
or a section, clicks one button, and Claude Code desktop opens on the right project with
the design brief loaded.

## How it works

A Figma plugin can only reach `http`, `https`, `ws`, and `wss`, so it can't launch
anything on your Mac by itself. That's why there are two halves:

1. **The plugin** expands the selection into a list of screens — a section becomes the
   frames inside it — and POSTs the file key and every node id to the bridge.
2. **The bridge** (a small Node server on `localhost:7331`) writes the implementation
   laws into the target project's `CLAUDE.md` and opens Claude Code desktop via
   `claude://code/new?q=...&folder=...`.
3. **Claude Code** reads the actual design through the Figma MCP (`get_design_context`,
   `get_variable_defs`, `get_screenshot`, `download_assets`) and builds it.

The prompt in the composer stays short — the screens, their Dev Mode links, and how to read
them — so the designer approving it can actually finish reading it. The ten laws go into the
project's `CLAUDE.md`, which Claude Code loads for the whole build rather than only the
first turn, and the prompt points at that file and at
[the canonical copy](https://raw.githubusercontent.com/maljaburi/FigmaToClaude/refs/heads/main/standards/figma-laws.md)
— the raw URL, so anything that follows it gets the markdown rather than a GitHub page.
They were once pasted into the composer as well, which put the entire ruleset on top of a brief
that now runs under 600 characters for two screens — and that length was costing exactly the
review the prompt existed to enable. How to read a design — which MCP call, in what order — is
in the laws for the same reason: it is a working method rather than a fact about this send, and
it has to hold past the turn where the composer scrolls out of the context. That link serves whatever is on `main`, while the copy
written into the project comes from the designer's own clone, which follows `release` — so
between a push and a release the two can differ, and the `CLAUDE.md` in the project is the
one that governs the build.

## Setup

Paste this into Terminal:

```bash
[ -d ~/.figma-to-claude/app/.git ] || git clone https://github.com/maljaburi/FigmaToClaude.git ~/.figma-to-claude/app && ~/.figma-to-claude/app/install.command
```

It checks for Node, installs a launchd agent so the bridge runs from login onward
(`KeepAlive`, logs to `~/Library/Logs/figma-to-claude-bridge.log`), waits for the bridge
to actually answer on its port, and then prints the two remaining Figma steps. Re-running
it updates to the latest and is safe.

The `[ -d … ]` guard is load-bearing, not decoration. Several panel screens tell a designer
to re-run this command, and `git clone` into an existing directory is fatal — with a bare
`clone && install.command` the `&&` then skips the install step, so the re-run they were
told to do printed an error and changed nothing.

Then in Figma: **Plugins → Development → Import plugin from manifest**, and pick
`plugin/manifest.json` from the cloned folder.

The bridge auto-connects the Figma MCP to Claude Code on startup. The one thing that
can't be automated is the Figma OAuth approval, so run `/mcp` in Claude Code once and
approve Figma in your browser.

To remove it: `~/.figma-to-claude/app/bridge/autostart.command uninstall`. For a one-off
run without installing, double-click `bridge/start.command` instead — but don't run both,
they fight over the port.

## First run

The plugin checks this Mac and shows whichever screen applies, switching by itself as
things come up — nothing to click through:

| State | Screen |
|---|---|
| Bridge not installed | Three-step setup: open Terminal, copy the command, wait |
| Bridge up, something else missing | The one thing to fix, e.g. approve Figma with `/mcp` |
| Everything ready, first time | "You're set up" with what was verified |
| Everything ready, returning | Straight to the working panel |

Step 3 of setup polls every 2 seconds, so the panel notices the helper on its own within
a couple of seconds of the install finishing. A returning designer never sees any of it —
including across the restart the bridge does after pulling new code, where the panel holds
what it's showing for a few polls rather than reading a missing bridge as an uninstalled
one.

### Checking those screens without Figma

Which one you see depends on a status only your own Mac produces, so opening the plugin
proves very little about the rest. `node preview/run.js` loads the real `plugin/ui.html`,
feeds it every status the bridge can return over the same message channel Figma uses, and
checks what comes back: one view visible at a time, each panel sized to its own content,
the buttons wired to something, and the command the Copy button hands over still identical
to the one in this file. It writes `preview/screens.png` and exits non-zero if a check
fails. Needs Chrome; no dependencies to install.

## Using it

1. Select one or more frames on the canvas, or a section — a section sends the frames
   inside it, in the order they read left to right and top to bottom.
2. Run the plugin. It lists the screens it is about to send.
3. Pick where it builds. **Default** creates a folder in the default location, named after
   the first screen. **Select Folder…** opens the macOS folder dialog, where you choose the
   location and — with its New Folder button — the name; the panel has no naming field of
   its own because that dialog already does it better and knows which names are free.
   Under those sits **Recent**: the folders you have built into before, newest first, which
   is how a send goes back into an earlier build. A first-time designer has no Recent list
   and starts on **Default**; after that the panel opens on the folder used last, per Figma
   file and then wherever that file is new. Settings is where you change the default
   location.
4. Click **Send to Claude Code**. Claude Code opens with the prompt loaded.
5. Press Enter to start the build.

Everything in one send becomes one project and one Claude Code session, so the screens
share tokens and components instead of each inventing their own. The panel warns past 12
screens and refuses past 30 — a build that large is better sent in batches.

The gear opens **Settings**: what the plugin does, how to use it, where builds go and how
to change it, the state of all four connections at once, who to message on Slack, and the
plugin, bridge, standards and Node versions. It is reachable from the blocked screen too, which names only the first problem
it hits — the connection list is how you find out whether anything else is wrong.

Step 5 is a real Enter press. The `claude://code/new` route pre-fills the prompt but
does not submit it. Verified against Claude.app 1.25927.0 and re-checked on 1.26832.0;
if a future build ever auto-submits, the designer loses the review step, so it is worth
re-checking after a major Claude Code update.

## Where the prompts live

Every word that reaches Claude Code is a file in `standards/`. None of it is a string
inside `server.js`, so the wording can be changed without shipping code.

| File | Becomes | Editable placeholders |
|---|---|---|
| `figma-laws.md` | a managed block in the project's `CLAUDE.md` | none, it's prose |
| `prompt.md` | the text in the Claude Code composer | per send: `{{screenCount}}` `{{file}}` `{{page}}` `{{laws}}` — per screen: `{{name}}` `{{type}}` `{{size}}` `{{nodeId}}` `{{devLink}}` `{{designSource}}` |

The two groups are not interchangeable. The block between `SCREEN:BEGIN` and `SCREEN:END` is
rendered once per selected screen and sees only the per-screen values; everything around it is
rendered once and sees only the per-send ones. `{{nodeId}}`, `{{devLink}}` and `{{laws}}` are
available but unused by the shipped wording — `{{designSource}}` already gives each screen its
Dev Mode link, or tells the agent to read that screen through the MCP when there is no link,
and `{{laws}}` still expands to the full ruleset, so an org that wants the laws in the composer
can put it back on a line of its own.

An unknown `{{placeholder}}` is left visible in the output rather than silently becoming
an empty string, so a typo shows up instead of quietly dropping content. HTML comments in
`prompt.md` are notes to whoever edits it and are stripped before the prompt is rendered, so
they never reach the composer.

Nothing in the prompt describes the folder being built into. The laws do that instead, by
telling the agent to look when it opens the folder and branch on what it finds — read and
extend whatever is already there, or establish the tokens and components as it goes if the
folder is empty. The prompt used to assert which of the two it was, from a check made while
the send was being prepared, and the folder could have changed by the time anything read it.

**If either can't be loaded, the send is refused.** Nothing is written and Claude Code is
not opened. A build missing its standards would silently guess at values, which is worse
than no build. The panel replaces the working view with a blocking screen naming the file
that could not be loaded.

The `CLAUDE.md` copy is the one that does the work: it still holds after forty tool calls,
when the prompt has scrolled out of the way. It is written before Claude Code is opened, so
by the time the agent reads the prompt's pointer the file it points at is already loaded.

The replacement is validated in memory before anything is written, then written via a temp
file and a rename, so a failed or interrupted send can never leave a half-written
`CLAUDE.md`. Anything outside the managed block is preserved. If a project's `CLAUDE.md`
already contains an unpaired marker — which an older version of the bridge could leave
behind — the send is refused rather than guessing which half of the file is yours.

### Keeping every designer on the same prompts

**Edit `standards/`, commit, then fast-forward `release`.** That's the whole distribution
mechanism — see [Shipping an update](#shipping-an-update) for the release step.

The bridge distributes over git rather than HTTP. Every designer already has a clone,
since that's how the bridge got installed, so before each send it runs:

```
git -C <clone> pull --ff-only --quiet
```

Throttled to once every 5 minutes, and `--ff-only` so a designer's accidental local edit
is reported rather than silently overwritten. If the pull fails for any reason, it logs
and carries on with the copy already on disk, so a network blip never strips the
standards out of a build. Set `SELF_UPDATE=0` to turn it off.

A pull that changes anything under `bridge/` also restarts the bridge, so the code a
designer runs matches the standards they just received. That restart is what the panel’s
grace window covers.

`STANDARDS_URL` remains for hosting the directory somewhere anonymously readable. Per
file, the resolution order is:

1. `STANDARDS_URL` + filename, if the body passes a sanity check. `figma-laws.md` must
   contain *both* managed-block markers — an opening one on its own is a truncated body, and
   accepting it leaves a stray marker that a later send slices the designer's own text out
   from — and `prompt.md` must contain both `SCREEN` markers and a `{{placeholder}}`. Between
   them, that stops an SSO login page returning HTTP 200 from being written in as "the laws"
2. the last good fetch, cached under `~/.figma-to-claude/standards/`
3. the copy in `standards/`, kept current by the git pull above

Settings reports the version the standards resolved to, on its **Standards** row, and the
bridge log breaks that down per file — so a designer running stale prompts is visible
rather than invisible. It is deliberately not on the setup success screen: that screen is
unreachable while the standards are broken, so the only thing it could ever show there is
a tick.

## Shipping an update

Updates reach designers down two separate channels, and only one of them is git.

| What changed | How it reaches people | How long |
|---|---|---|
| `standards/`, `bridge/` | `git` — fast-forward `release` | next send, within 5 minutes |
| `plugin/` | republish in Figma | next time they run the plugin |

**The bridge and the standards update themselves.** Machines follow the `release` branch,
not `main`. Work lands on `main` as usual and reaches nobody; a release is one
fast-forward:

```bash
git push origin main:release
```

Push the refspec rather than checking `release` out. A local `release` branch is somewhere
to accidentally commit, and a commit made there is live on every machine before it has been
reviewed anywhere else — which is the failure this branch exists to prevent.

Within five minutes every designer's next send pulls it, and if anything under `bridge/`
changed the bridge restarts itself onto the new code. Nobody installs anything. Cut a
GitHub release against that commit too if you want a changelog — nothing reads it, but
it's the record of what `release` pointed at and when.

**Creating `release` for the first time, point it at what is already running**, not at
`main`. Until the branch exists on the remote every installed machine is still following
`main`, so creating it at the current `main` ships whatever has accumulated there to
everyone at once — the opposite of what the branch is for:

```bash
git push origin <sha-of-what-is-live>:refs/heads/release
```

**Rolling back means going forwards.** Clients pull with `--ff-only`, which is what stops
an update from overwriting a designer's local edit — so force-pushing `release` backwards
would leave every machine silently unable to update. Revert on `main` and fast-forward
again.

**The plugin can't come down that channel at all.** Figma serves `plugin/` from what was
published to the org, not from the clone on disk, so pulling a new `ui.html` changes
nothing. Republishing is what ships it, and Figma then rolls it out on its own — everyone
runs the latest published version. This is why the bridge has to stay the
backward-compatible side: a designer can be on a months-old plugin talking to today's
bridge, so `/build` keeps accepting old payload shapes and limits are enforced in the
bridge rather than the plugin.

**Trying something on one machine first.** `UPDATE_CHANNEL=main` in the LaunchAgent's
`EnvironmentVariables` puts that Mac on every commit while the org stays on `release`. Its
settings screen grows a **Channel** row, so a bug report from it identifies itself. Setting
`SELF_UPDATE=0` instead pins a machine to whatever is checked out, which is what a
development install wants.

The switch between channels happens inside the pull, not in the installer — a designer is
never going to re-run an installer to change a branch they don't know exists. It declines
rather than forces: if the channel branch isn't on the remote yet, or the clone has
uncommitted changes, it logs and stays where it is.

## Publishing to the org

Publish it **privately to the organization**, never publicly to Community: a public plugin
can't use `enablePrivatePluginApi`, so `figma.fileKey` would return undefined and every
send would lose the Figma link.

Private org plugins skip Figma's review and any org member can publish one, so this
doesn't need an admin. In Figma: **Plugins → Development → Publish**, then set
**Publish to** to your organization. Teammates then find it under **All teams → Plugins**.

Figma assigns a real plugin ID on publish and rewrites `manifest.json`. Commit that back,
or the next publish creates a second, separate plugin.

## Pinning the model

The `claude://code/new` deeplink has no model or effort parameter, so the bridge pins
them in the target project's `.claude/settings.json` instead, which the desktop app reads
when it opens the folder. Default is Opus at `xhigh`:

```json
{
  "model": "opus",
  "effortLevel": "xhigh"
}
```

An existing `settings.json` is merged, not replaced, so a project's own `permissions` and
other keys survive. If the file isn't valid JSON (hand-edited, or has comments), the
bridge leaves it completely alone and says so rather than destroying it.

**`max` cannot be pinned.** The settings schema is
`effortLevel: E.enum(["low","medium","high","xhigh"]).catch(void 0)`, so `max` is not
accepted, and because of the `.catch()` an invalid value is *silently discarded*. Writing
`"effortLevel": "max"` looks like it worked and quietly gives you the default instead. The
bridge refuses it, logs why, and leaves effort unset rather than writing a lie.

To actually run at `max`, type `/effort max` in the session. It is a live level, just not
a persistable one. Note that an org policy can also cap effort per model, in which case
Claude Code downgrades with a message about exceeding your organization's limit.

## Bridge configuration

A launchd agent inherits nothing from your shell, so these have to be set **when you run
the installer**. `autostart.command` captures whichever ones are present and writes them
into the agent's `EnvironmentVariables`, then prints back what it captured:

```bash
BUILD_MODEL=sonnet STANDARDS_URL=https://internal.example/standards/ \
  ~/.figma-to-claude/app/install.command
```

| Variable | Default | What it does |
|---|---|---|
| `PROTOTYPES_DIR` | `~` | Where **Default** creates its folder. Defaults to the home directory because Claude Code usually treats it as a trusted workspace, so a folder created inside it opens without a trust prompt. |
| `STANDARDS_URL` | unset | Org-hosted `standards/` directory. **Must be `https://`** — a plaintext value is refused at startup, because whatever it serves becomes standing instructions for an agent with write access to your projects. Capped at 512 KB. Wins over the bundled copies, cached for 5 minutes. |
| `BUILD_MODEL` | `opus` | Model pinned in the project's `.claude/settings.json`. Empty string leaves it alone. |
| `BUILD_EFFORT` | `xhigh` | Effort pinned alongside it. Only `low`, `medium`, `high`, `xhigh` persist. |
| `SELF_UPDATE` | on | Set to `0` to stop the `git pull` before each send. |
| `UPDATE_CHANNEL` | `release` | The branch this machine follows. `main` makes it a canary that gets every commit. Ignored when `SELF_UPDATE=0`. |
| `SKIP_AUTOSETUP` | unset | Skip auto-connecting the Figma MCP on startup. |
| `PRETRUST` | on | Set to `0` to let Claude Code ask about each folder itself. See below. |
| `SUPPORT_SLACK_ID` | `U0A7ZH40VMK` | Who the settings screen's support link messages. |
| `SUPPORT_SLACK_TEAM` | `E02QZN4PXRT` | Workspace (`T…`) or Enterprise Grid org (`E…`) that id belongs to. Without it the link can only open Slack on a profile page, not a DM. |
| `SUPPORT_URL` | the profile link | Where the link falls back to when Slack isn't installed. |
| `PORT` | `7331` | Listen port. **Changing this breaks the plugin.** The manifest's `allowedDomains` fixes the port at publish time, so the plugin can only ever reach 7331 — a bridge on any other port reads as "not installed". The installer warns if you set it. |

Node 18 or newer is required (`fetch` and `AbortSignal.timeout`). Older versions exit with
a message rather than crash-looping under `KeepAlive`.

`PROTOTYPES_DIR` only sets the starting value. A designer can move it from Settings, under
**Where builds go**, and the choice is remembered in `~/.figma-to-claude/prefs.json`, which
outlives both re-running the installer and a self-update. The same file holds the **Recent**
list. It is the only bridge state that survives a restart; delete it to go back to the
configured default and an empty list.

## Skipping the trust prompt

Claude Code asks whether you trust a folder the first time it opens one. For a folder the
bridge just created, at the designer's request, from their own selection, that prompt has
nothing in it they don't already know — but it does stop the build until someone notices
the modal. So before firing the deeplink the bridge marks the target
`hasTrustDialogAccepted` in `~/.claude.json`, which is exactly what accepting the dialog
writes.

That file belongs to Claude Code and has no versioned contract, so every branch of that
code fails toward leaving it untouched and letting the prompt appear: unparseable JSON, a
`projects` key that isn't an object, an entry for this directory that isn't an object, or
any write error. A trust prompt is a small annoyance; a corrupted `~/.claude.json` is a
designer's entire Claude Code history. It re-serialises at two-space indent with no
trailing newline, byte-for-byte how Claude Code writes it, so a send adds one key rather
than reformatting the whole file.

Set `PRETRUST=0` if you'd rather keep the prompt. Note that a Claude Code session running
at the same time can rewrite the file from memory and drop the key; the prompt then appears
once, which is the behaviour you had anyway.

## What the bridge will and won't accept

It binds loopback only, but that isn't a boundary by itself — every browser tab on your
Mac is also on loopback. So it additionally requires a loopback `Host` header, which is
what stops a hostile DNS name pointed at `127.0.0.1`, and refuses any request carrying a
normal web origin. The plugin sandbox sends no origin (or a `figma.com` one) and is
allowed; a page you happened to visit is not.

The **Build into** dropdown is served as opaque ids, never absolute paths, and a build
target is resolved by looking that id up — so `/build` can only ever write inside a folder
the designer has already built into or has just picked in the native dialog on their own
Mac. No request body ever names a path.

`/open-support` takes no parameters for the same reason in a different direction: it opens
a Slack deeplink the bridge holds, not a URL the caller supplies, so it can't be used to
launch an arbitrary URL scheme on the designer's Mac.

## Verifying a change

```bash
npm run verify     # unit tests, then every plugin screen rendered and checked
```

`npm test` runs the bridge's behaviour tests (`node --test bridge/server.test.js`) —
`writeLaws` preserving your `CLAUDE.md`, `pinModel` refusing to touch a file it can't
parse, `slugify` staying inside the prototypes directory, and the request guards.

`npm run preview` is described under [First run](#checking-those-screens-without-figma).

## Troubleshooting

**The panel says the helper isn't installed.** Either the bridge isn't running or it's on
the wrong port. Check `~/Library/Logs/figma-to-claude-bridge.log` — every line is
timestamped — or run `bridge/start.command`. If you set `PORT`, unset it: the plugin can
only reach 7331.

**It's stuck on "Connect Figma to Claude Code".** The button registers the MCP server with
the `claude` CLI. If it keeps returning, the CLI isn't on the PATH the agent inherits —
the log will say so. Re-running `install.command` rebuilds the agent with a current PATH.

**It's stuck on "One last approval".** Registered isn't authorized. Run `/mcp` in Claude
Code and approve Figma in the browser. One time only.

**A send is refused with "unterminated managed block".** An older bridge left a stray
`FIGMA-TO-CLAUDE-CODE` marker in that project's `CLAUDE.md`. Delete the stray marker line
and send again — the refusal is deliberate, because guessing which half of the file is
yours is how content used to get deleted.

**Nothing happens when you click Send.** Check whether the deeplink reached the app:

```bash
grep -a 'saveTrust' ~/Library/Logs/Claude/main.log | tail -3
```

A `Saved workspace trust` line with your project path means the deeplink worked and
Claude Code is waiting on the Enter press.

**The frame link field keeps appearing.** That's `figma.fileKey` returning undefined,
which is expected until the plugin is published privately to the org.
