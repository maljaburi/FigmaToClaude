# Working in this repository

A Figma plugin plus a local Node bridge that opens Claude Code desktop on a selected
frame. `README.md` explains what it does and how to install it; this file is the set of
conventions that aren't obvious from reading the code, and that a change will otherwise
break silently.

## Constraints that are not negotiable

**No dependencies in the bridge.** `bridge/package.json` has no `dependencies` and no
lockfile, and that is deliberate: this runs on designers' machines under a launchd agent
that self-updates over `git pull`, so a transitive dependency is a supply-chain path onto
every machine in the org. Node builtins only. The same applies to `preview/`.

**Every word that reaches Claude Code lives in `standards/`.** Never put prompt or laws
text in a string inside `bridge/server.js`. The whole point is that the wording can be
edited and distributed by someone who doesn't ship code. If you need a new value in the
prompt, add a `{{placeholder}}` to `standards/prompt.md` and a key in `templateVars()`.
There are now no exceptions: `buildContext()` was the last one, three strings describing
what the target folder held, and it is gone. Not for tidiness — the bridge was asserting a
fact it had measured while resolving the target, and the agent reads that sentence after the
deeplink opens, by which time the designer can have emptied the folder in Finder or an
earlier session left half a build in it. The laws now tell the agent to look at the folder
and decide, which it can do and a template cannot; the preamble to `figma-laws.md` and law 4
carry it. Anything you are tempted to state about the target on the way past belongs there
too, phrased as an instruction to check rather than a claim.

**The laws reach the agent through `CLAUDE.md`, not through the prompt.** `writeLaws()`
puts the full ruleset in the target folder before the deeplink opens, so Claude Code has
all ten in context for the whole session; `prompt.md` only points at them. They used to be
pasted into the composer as well, which tripled its length — and a brief nobody finishes
reading is not the review step it was meant to be. Whichever way you change this, one of
the two has to carry them: `bridge/server.test.js` fails if `prompt.md` stops doing either.
Notes to whoever edits `prompt.md` go in HTML comments, which `buildPrompt()` strips per
piece before rendering — they were reaching the composer verbatim, and one of them pasted
the whole ruleset into a sentence explaining why the ruleset isn't pasted in.

**A send is a list of screens, never one frame.** A selection expands: sections become the
frames inside them, and `screensOf()` normalises both that list and the older single-frame
payload into one array. `templateVars()` holds what the whole send shares; `screenVars()`
holds what differs per screen; the block between `SCREEN:BEGIN` and `SCREEN:END` in
`prompt.md` is repeated once per screen. Render each piece exactly once — see below.

**The published plugin lags the bridge.** The plugin is frozen at whatever was published to
the org, while the bridge self-updates over `git pull`. So the bridge is the compatible
side: `/build` must keep accepting a payload with no `screens` array, and limits like
`MAX_SCREENS` are enforced there because the plugin's copy can't be changed for anyone who
hasn't reinstalled. The plugin still sends the first screen's fields on the envelope for
the same reason in reverse.

**`main` is not what anyone runs.** Machines follow `release`, and a release is a
fast-forward of that branch — before this existed, `main` *was* production and a commit
pushed while thinking out loud was live on every designer's Mac within five minutes. Two
consequences. Rollback is forwards only: clients pull `--ff-only`, so moving `release`
backwards leaves every machine quietly unable to update, and a revert commit is the only
safe way back. And `ensureChannel()` runs `git checkout` unattended in someone else's
working tree, so it declines on anything unexpected — a channel branch not yet on the
remote (true of every machine between shipping the code and cutting the first release) and
a dirty tree both leave the clone where it is. `bridge/server.test.js` drives it against
real throwaway clones; the guards are what those tests are for.

**Three runtimes, three different sets of globals.** `bridge/` is Node. `plugin/code.js`
runs in the Figma plugin sandbox, which has no DOM and a limited set of globals — it uses
`var`/ES5-flavoured code and guards anything modern (see the `AbortController` fallback in
`bridgeFetch`). `plugin/ui.html` runs in an iframe with a DOM but no `navigator.clipboard`.
Don't move code between them without checking what it can reach.

**The port is fixed at 7331.** `plugin/manifest.json`'s `allowedDomains` is what Figma
enforces, and it's frozen when the plugin is published. `PORT` exists on the bridge but
changing it makes the plugin report a healthy bridge as missing. `preview/run.js` asserts
the two files agree.

## Things that have gone wrong before

**Writing to a project's `CLAUDE.md`.** `writeLaws()` composes and validates the whole
replacement in memory, then writes once via `writeFileAtomic`. It previously wrote first
and validated after, which left corrupted files on disk and eventually deleted designers'
own notes. If you touch it, `bridge/server.test.js` has the regression cases — keep them
passing.

**Trusting `claude mcp get figma` output.** It's human-readable CLI text with no versioned
contract. `figmaMcpState()` parses it defensively and, when it can't classify the output,
reports `needs-auth` rather than `missing` — because `missing` routes the designer to a
Connect button that re-registers an already-registered server forever, while `needs-auth`
sends them to `/mcp`, which is recoverable either way.

**Caching a "ready" flag.** Anything that records "we already did this" needs to be
invalidated when the underlying thing can change. A `figmaReady` boolean that was set and
never cleared meant the Connect button reported success without doing anything after the
user removed the MCP server by hand.

**Request data reaching the filesystem.** `/build` resolves its target by looking up an
opaque id in `projectIndex`. Never accept a path from the request body. `/choose-folder`
and `/choose-target` are not exceptions: the request asks for a native dialog to open, and
the path comes back from the designer clicking a folder on their own Mac, not from the
caller. `/choose-target` registers what came back in `chosenTargets`, which exists because
`publishProjects()` rebuilds `projectIndex` on every poll — a folder that had been picked
but not yet built into stopped resolving a second after it was chosen.

**Opening things on the designer's Mac.** `figma.openExternal` refuses every scheme but
http(s), so the panel cannot reach a `slack://` link and the support link could only ever
put a browser on a profile page — two clicks and an SSO round trip from a message box.
Opening the app is therefore the bridge's job, and `/open-support` takes **no parameters**:
the panel asks that support be opened, and the bridge decides what that means. A bridge that
opened a URL from the request body would hand any page that got past the origin checks a way
to launch arbitrary schemes here. `openSupport()` then degrades on its own — deeplink, then
`open -a Slack`, then a browser — because the screen this link lives on is the one a designer
opens when nothing else works, including the bridge. It used to swallow every failure in a
bare `catch {}`, which is why a link that did nothing was indistinguishable from a link that
worked.

**Writing files that belong to another program.** `trustProject()` edits `~/.claude.json`
so Claude Code doesn't halt the build on a trust modal, and `pinModel()` edits the
project's `.claude/settings.json`. Neither file has a versioned contract, so both validate
the shape first and return without writing on anything unexpected — an un-skipped prompt is
recoverable, a corrupted config is somebody's entire history. Match the existing
serialisation exactly (`~/.claude.json` is two-space indent, *no* trailing newline) or
every send rewrites the whole file.

**Rendering a template over already-rendered text.** `buildPrompt()` renders the head, the
screen list and the tail separately and concatenates them. Splicing the screens in and
rendering the result put frame names through a second substitution pass, so a frame named
`{{laws}}` — a legal Figma layer name — emptied the entire ruleset into its own heading.

**Telling the agent what is in a folder we haven't looked in.** The prompt used to state it,
from `target.created` — whether *this process* had just run `mkdir`. That is not the same
question as whether the folder holds anything, so a folder the designer made with New Folder
in the macOS picker, and one left behind by a send that built nothing, were both told they
"already hold a previous build". Reading the directory instead was the obvious fix and was
built; measuring it honestly was the harder half, because `/build` writes `CLAUDE.md` and
`.claude/settings.json` into the target moments later and a verdict taken after those two
writes calls every folder occupied. What replaced the whole thing is the preamble to
`figma-laws.md`: the agent is told to look, and it looks after the deeplink has opened, which
is the only moment when the answer is still true. So the pattern to watch for is not the
`created` flag specifically — it is this bridge asserting anything about a folder it will hand
to someone else before they read it. `bridge/server.test.js` fails if such a string returns to
`server.js`. The panel makes the same claim in `renderTargetHint()` and has the same problem;
that one is unresolved.

**A flex child that won't scroll.** The screen list scrolls inside the panel, which needs
`min-height: 0` on *every* link from `body` down to the list, and `height: 100vh` on the
body rather than `min-height`. Miss one and the floor re-establishes itself further up: the
list grows past the window and pushes the send button out of reach entirely, with no
scrollbar and nothing failing. `preview/screens.html` asserts the button is on screen with
34 screens selected. The list itself is `flex: 0 1 auto` — shrink but never grow — which is
what lets it give way in a window shorter than the panel asked for without stretching in
one that is taller.

**A header that is only a count.** The row above that list is the number of screens and,
past twelve of them, the warning beside it. Nothing else: it named the Figma page as well,
which is text of any length, and that wrapped the row onto a second line and took the
warning with it. Truncating the name to an ellipsis was shipped and then dropped in favour
of removing it, so putting context back in that row means taking the wrap back too. What is
left has no give in it — neither box shrinks and neither wraps — so the pair is one line for
exactly as long as it fits, and a warning worded any longer would slide off the panel edge
rather than wrap or scroll anywhere visible. `preview/screens.html` measures that row's
height *and* its width at 34 screens, where the warning is at its longest; the width is the
half that can still fail.

**Filling the slack in a docked panel.** Figma often hands the panel far more height than
it asks for. Three attempts to put that space to use were shipped and then removed, and the
answer is that nothing should: **no element in the panel stretches to fill the window.**
Stretching the selection card produced a 600px box holding one line of text. Stretching the
screen list drew the same window-high box for two screens as for thirty, which reads as a
list that failed to load. Rendering the frame to a PNG and showing it filled the space
honestly but bought nothing — the designer is looking at that frame on the canvas behind
the panel. Each one *looked* like the fix while it was being written.

What is left: everything sizes to its own content, the screen list grows a row at a time up
to a cap and scrolls past it, and the leftover collects below the send button where it
claims nothing. `preview/screens.html` renders two, six and thirty-four screens and asserts
the list tracks the count, so a fourth attempt will fail there.

**Two decisions in one line of text.** The destination hint used to read "A new folder in ~
**Change**", where Change moved the directory *all* future builds land in — a preference,
sitting inside a sentence describing where this one send was going, one word away from the
control for that. It got read as "change where this build goes" and nothing in the panel
said otherwise. The preference now lives on the settings screen and the hint only describes
the current choice — but the hint still names the location, so anything that changes the
setting has to re-render it; `preview/screens.html` checks the hint follows the setting.

**Abbreviating a path in front of a designer.** `displayPath()` used to collapse the home
prefix to `~`, on the reasoning that it was noise. It is noise in a terminal; in the panel
it is the one line telling someone where their work is about to be written, and `~` is
shell notation they have no reason to know. Paths are now written out in full, and the
destination hint says nothing beyond where the Default option lands — it used to name Claude
Code's default location and explain how the new folder gets its name in the same breath,
which is three facts in a line that gets read as one. The install command is the exception
and keeps its `~`: that string is pasted into a shell, where the tilde is what makes it work.

**Offering somewhere as a place to build.** `listProjects()` is the folders this designer
has already built into, newest first, recorded by `rememberRecent()` *after* the launch
succeeds. It used to scan the destination directory, which since that directory defaults to
`~` meant Library, Movies, Public and node_modules were all offered as places to put a
prototype, with the one wanted folder somewhere down the alphabet. Two things follow. The
list can name a folder that has since been renamed or thrown away in Finder, so
`usableRecents()` drops what no longer exists rather than letting the send fail after the
button is pressed. And with no scan behind it, a first send has no list at all — the panel
omits the `optgroup` entirely instead of drawing an empty "Recent" heading, which reads as a
list that failed to load. Both are checked in `preview/screens.html`.

The rules live in `usableRecents()` and `nextRecents()`, which are pure, because the two
functions either side of them read and write the real `prefs.json` — an earlier version was
tested through `rememberRecent()` and rewrote the preferences of whoever ran the suite.

**Describing a folder the panel cannot see into.** The destination hint used to end "Adds
these screens to what is already there" whenever the choice came from Recent — a statement
about that folder's contents, inferred from nothing but which option was selected. The panel
has no way to check it: `/projects` carries an id and a name per folder and no listing, on
purpose, because the alternative is a `readdir` per folder on a two-second poll. So the line
was often simply wrong — an earlier build may have produced nothing, and Finder may have
emptied the folder since. It reads "Builds in a folder you've used before" now: provenance,
which membership of Recent does establish, instead of contents, which nothing the panel
receives can. The rule behind it is worth keeping in mind anywhere the panel writes a
sentence — it may say what it is about to do and where, and repeat what the bridge told it,
but it may not describe the state of something it has not been sent. `preview/screens.html`
pins that sentence exactly rather than searching it for banned words, so the next rewording
has to come back past the reason for this one.

**A green light nobody could act on.** The rail carries Bridge, Claude Code and Figma MCP —
the three connections a designer can do something about. The standards had a fourth dot, and
the setup success screen a fourth line, and neither could say anything worth reading: the dot
was green whenever nothing was wrong and red only alongside the blocked screen that already
stops the send and names the missing file, and the success line could only ever be a tick,
because that screen is unreachable while the standards are broken. Both are gone, and the rule
they leave behind is that standards state appears in exactly two places — the settings screen,
where someone is looking for the state of things, and `route()`'s standards branch, the only
thing in the panel that reports them breaking. Being the only signal is why
`preview/screens.html` drives that branch twice, from start-up and under a designer who was
already working when the files went away. It also counts the success screen's rows rather than
only looking for the word: a checklist that had stopped rendering altogether would pass an
absence test on its own.

**What the settings screen leads with.** It is opened almost entirely by someone whose send
didn't work, so it opens on Status — every connection and its state — and the instructions
sit below that. Leading with a paragraph about what the plugin is put four lines of prose
between a designer and the one thing they came for. `preview/screens.html` asserts the order
rather than the presence, because presence survived the version that read worst.

**A screen that routing can take away.** Settings is opened by a click, not by a status, so
`route()` returns early while `settingsOpen` is set. Without that the two-second poll
replaced it moments after it opened — and someone on a broken machine, which is most of why
that screen exists, could never finish reading it. The same screen renders from data that
arrives on its own schedule (`about` on init, `status` on the poll), so both handlers
re-render it while it's open rather than assuming they landed first.

## Layout

```
plugin/code.js       Figma sandbox: reads the selection, talks to the bridge
plugin/ui.html       the panel — six views, routed by bridge status, self-sizing
bridge/server.js     the whole bridge: HTTP, standards, MCP wiring, file writes
bridge/server.test.js  behaviour tests for the pure functions and the two writers
standards/           every word that reaches Claude Code
preview/             renders every panel state headlessly and checks them
install.command      designer-facing installer
bridge/autostart.command  writes and loads the LaunchAgent
jamf/install-bridge.sh    fleet deployment, runs as root, does the work as the user
```

`bridge/server.js` is one file on purpose. Its sections barely interact, and the only cost
that structure imposed — not being requirable without starting a server — is handled by
the `require.main === module` guard at the bottom. Don't split it.

## Verifying a change

```bash
npm run verify     # node --test bridge/server.test.js, then preview/run.js
```

`preview/run.js` needs Chrome. It asserts *which* view each status renders, not merely
that one did — an earlier version only checked the latter and let a routing bug through.
When you add a panel state, add its expected view and a distinguishing string to `STATES`
in `preview/screens.html`. A state reached by clicking rather than by a status carries
`click: "<element id>"`; the click fires after that frame's own scripted messages, because
a fixed delay from page load raced the iframes and clicked into a half-fed panel.

Two guards in the harness exist because they each hid a real failure once: it fails if the
rendered page overflows the screenshot (states were being silently cropped away), and a
check that throws reports itself as a failed check rather than leaving `run.js` to parse
the placeholder text as JSON.

## Style

Comments explain **why**, never what. Most of the comments in this codebase record a
decision or a failure that motivated the code — keep that bar; a comment that restates the
line above it should be deleted. User-facing strings are written for a designer, not an
engineer: name the next action, never the internal cause.
