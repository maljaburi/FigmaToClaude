# Send to Claude Code

A Figma plugin that turns a selected frame into a built screen. Designer selects a
frame, clicks one button, and Claude Code desktop opens on the right project with the
design brief loaded.

## How it works

A Figma plugin can only reach `http`, `https`, `ws`, and `wss`, so it can't launch
anything on your Mac by itself. That's why there are two halves:

1. **The plugin** reads the selected frame and POSTs its file key and node id to the
   bridge.
2. **The bridge** (a small Node server on `localhost:7331`) writes the implementation
   laws into the target project's `CLAUDE.md` and opens Claude Code desktop via
   `claude://code/new?q=...&folder=...`.
3. **Claude Code** reads the actual design through the Figma MCP (`get_design_context`,
   `get_variable_defs`, `get_screenshot`, `download_assets`) and builds it.

The prompt carries the frame, the Dev Mode link, and all the laws inline, so a designer
reading the composer can see exactly what's about to happen. The laws also go into
`CLAUDE.md`, which keeps them in context for the whole build rather than only the first
turn.

## Setup

Paste this into Terminal:

```bash
git clone https://github.com/maljaburi/FigmaToClaude.git ~/.figma-to-claude/app && ~/.figma-to-claude/app/install.command
```

It checks for Node, installs a launchd agent so the bridge runs from login onward
(`KeepAlive`, logs to `~/Library/Logs/figma-to-claude-bridge.log`), waits for the bridge
to actually answer on its port, and then prints the two remaining Figma steps. Re-running
it updates to the latest and is safe.

Then in Figma: **Plugins → Development → Import plugin from manifest**, and pick
`plugin/manifest.json` from the cloned folder.

The bridge auto-connects the Figma MCP to Claude Code on startup. The one thing that
can't be automated is the Figma OAuth approval, so run `/mcp` in Claude Code once and
approve Figma in your browser.

To remove it: `~/.figma-to-claude/app/bridge/autostart.command uninstall`. For a one-off
run without installing, double-click `bridge/start.command` instead — but don't run both,
they fight over the port.

## Using it

1. Select a frame or section on the canvas.
2. Run the plugin.
3. Pick where it builds. **New prototype** makes a folder per frame in
   `~/Design-Prototypes`, reused on later sends. Or pick an existing project to add the
   frame as a new screen. The choice is remembered per Figma file.
4. Click **Send to Claude Code**. Claude Code opens with the prompt loaded.
5. Press Enter to start the build.

Step 5 is a real Enter press. The `claude://code/new` route pre-fills the prompt but
does not submit it, which was verified against Claude.app 1.25927.0.

## Where the prompts live

Every word that reaches Claude Code is a file in `standards/`. None of it is a string
inside `server.js`, so the wording can be changed without shipping code.

| File | Becomes | Editable placeholders |
|---|---|---|
| `figma-laws.md` | inlined into the prompt, and a managed block in the project's `CLAUDE.md` | none, it's prose |
| `prompt.md` | the text in the Claude Code composer | `{{frameName}}` `{{frameType}}` `{{size}}` `{{file}}` `{{page}}` `{{nodeId}}` `{{devLink}}` `{{designSource}}` `{{laws}}` |

An unknown `{{placeholder}}` is left visible in the output rather than silently becoming
an empty string, so a typo shows up instead of quietly dropping content.

**If either can't be loaded, the send is refused.** Nothing is written and Claude Code is
not opened. A build missing its standards would silently guess at values, which is worse
than no build. The plugin shows a red **Laws** dot naming the missing file.

The laws appear in both places on purpose. The prompt is what a designer reads; the
`CLAUDE.md` copy is what still holds after forty tool calls, when the prompt has scrolled
out of the way. After writing, the file is read back to confirm the managed block is
really there. Anything outside the block is preserved.

### Keeping every designer on the same prompts

**Edit `standards/`, commit, push. That's the whole distribution mechanism.**

The bridge distributes over git rather than HTTP. Every designer already has a clone,
since that's how the bridge got installed, so before each send it runs:

```
git -C <clone> pull --ff-only --quiet
```

Throttled to once every 5 minutes, and `--ff-only` so a designer's accidental local edit
is reported rather than silently overwritten. If the pull fails for any reason, it logs
and carries on with the copy already on disk, so a network blip never strips the
standards out of a build. Set `SELF_UPDATE=0` to turn it off.

`STANDARDS_URL` remains for hosting the directory somewhere anonymously readable. Per
file, the resolution order is:

1. `STANDARDS_URL` + filename, if the body passes a sanity check. `figma-laws.md` must
   contain the managed-block marker and the templates must contain a `{{placeholder}}`,
   which stops an SSO login page returning HTTP 200 from being written in as "the laws"
2. the last good fetch, cached under `~/.figma-to-claude/standards/`
3. the copy in `standards/`, kept current by the git pull above

The plugin shows a combined version hash next to the Laws dot and the bridge log breaks
it down per file, so a designer running stale prompts is visible rather than invisible.

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

| Variable | Default | What it does |
|---|---|---|
| `PORT` | `7331` | Port to listen on. Must match `BRIDGE` in `plugin/code.js` and `allowedDomains` in the manifest. |
| `PROTOTYPES_DIR` | `~/Design-Prototypes` | Where "New prototype" builds land. |
| `PROJECT_ROOTS` | `~`, `~/Desktop/Projects`, prototypes dir | Colon-separated dirs scanned for the project dropdown. Anything with a `package.json` or `.git` counts. |
| `STANDARDS_URL` | unset | Org-hosted `standards/` directory. Wins over the bundled copies, cached for 5 minutes. |
| `BUILD_MODEL` | `opus` | Model pinned in the project's `.claude/settings.json`. Empty string leaves it alone. |
| `BUILD_EFFORT` | `xhigh` | Effort pinned alongside it. Only `low`, `medium`, `high`, `xhigh` persist. |
| `SKIP_AUTOSETUP` | unset | Skip auto-connecting the Figma MCP on startup. |

## Troubleshooting

**Bridge dot is red.** The bridge isn't running. Check
`~/Library/Logs/figma-to-claude-bridge.log`, or run `bridge/start.command`.

**Figma MCP dot is red.** Click **Connect Figma MCP** in the plugin, then run `/mcp` in
Claude Code and approve Figma in the browser.

**Nothing happens when you click Send.** Check whether the deeplink reached the app:

```bash
grep -a 'saveTrust' ~/Library/Logs/Claude/main.log | tail -3
```

A `Saved workspace trust` line with your project path means the deeplink worked and
Claude Code is waiting on the Enter press.

**The frame link field keeps appearing.** That's `figma.fileKey` returning undefined,
which is expected until the plugin is published privately to the org.
