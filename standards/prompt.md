Build the screens listed below ({{screenCount}} in total) in this project, from {{file}} · {{page}}.

<!-- SCREEN:BEGIN (repeated once per selected frame — edit the wording, keep the markers) -->
### {{name}} — {{type}}, {{size}}
{{designSource}}
<!-- SCREEN:END -->

Read the design before writing anything: `get_design_context` for every value, `get_variable_defs` for the token map, `get_screenshot` as the reference for the final visual diff, `download_assets` for every icon. Do this per screen, in the order listed.

The ten Figma implementation laws in this project's `CLAUDE.md` are binding — read them
before you start and hold to them for the whole build, not only the first turn.
Canonical copy: https://raw.githubusercontent.com/maljaburi/FigmaToClaude/refs/heads/main/standards/figma-laws.md

<!-- The laws are pointed at rather than pasted in. The bridge writes the full text into
     the project's CLAUDE.md before Claude Code opens, so the agent already has all ten in
     context for the entire session — inlining them here only made the composer long enough
     that the designer approving the send stopped reading it. The link is for that person,
     not for the agent, which is why the sentence above names the file on disk first: a
     fetch can fail, a file that is already loaded cannot. It is the raw URL rather than
     the GitHub page because the one thing that might follow it is a fetching tool, and
     that wants the markdown, not a page of GitHub's markup wrapped around it.

     What the folder already holds is not described here either, and there is no placeholder
     for it. Anything this file could assert about that is a snapshot taken before Claude Code
     opens, and the folder can be emptied or half-built in between; the laws tell the agent to
     look at the folder and decide, which is a thing it can do and this file cannot.

     To go back to the old behaviour, put {{laws}} on a line of its own — the placeholder
     still resolves. -->
