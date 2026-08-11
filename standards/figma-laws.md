<!-- FIGMA-TO-CLAUDE-CODE:BEGIN (managed block, edits here are overwritten on the next send) -->
## Figma implementation laws

These apply to any task.

Before anything else, look at what the folder you have been opened in already holds. It
decides how the laws below land, and it is a question of fact — check it, rather than
assuming which kind of folder this is from the brief.

If it holds work already — a previous build of these screens, or a codebase of any kind —
read that before you write anything, and then extend it in place. Never start it over, and
never stand a second set of components, tokens or layout patterns up beside the ones that
are already there.

If it is empty, there is no existing codebase yet, so the laws about reusing components and
mapping to code tokens apply from the second screen onward — establish the token or
component on the first screen, then reuse it. Establish them as if they were the design
system, because to the next send into this folder they are: it will find them and be bound
by these same laws to reuse them.

Either way, never treat "the project is empty" as permission to guess a value: an
unresolvable value is still a STOP.

1. **No guessing.** Every color, spacing, radius, font, size, and string comes from
  Figma MCP output or from existing code. If a value cannot be resolved from either,
   STOP and ask. Never approximate, never round to a "nicer" number, never substitute
   a similar token. 13px stays 13px.
2. **No screenshot-only builds.** `get_design_context` is the source of truth.
  A screenshot is for validation, never for reading values off of.
3. **Tokens over literals.** If a value exists as a Figma variable, it must render as
  the mapped code token — never a raw hex or px. If no code token maps to it, STOP and
   ask whether to add a token or hardcode.
4. **Reuse before creating.** Search the codebase for an existing component, layout
  pattern, or token before writing a new one, starting with whatever the folder you were
   opened in already holds. A second component standing beside one that already does the
   job is a failure of this law, not a new feature. Report what was reused.
5. **Never hand-draw an icon.** Icons and images ship from exported Figma assets or an
  existing project component whose glyph actually matches. No inline `<path>` you
   authored, no placeholders, no omissions.
6. **Never claim done without a visual diff.** "Looks right" is not a status. A build is
  only complete after a screenshot comparison against the Figma reference passes.
7. **Surface deviations.** Anything that intentionally differs from the design gets
  listed with a reason. Silent drift is a failure, not a shortcut. Also use /goal loop to keep validating until all designs are implemented correctly.
8. **Measure spacing, never eyeball it.** Padding, gaps, and alignment come from the
  layout values in the MCP output, not from what looks close in the render. These are  
   the values most often approximated, and unlike a wrong color, a 2px gap error can  
   survive the screenshot comparison in law 6.
9. **Everything interactive must actually work.** Toggles, checkboxes, radio buttons,
  inputs, dropdowns, tabs, and every other control ship functional — never a static
   picture of a control. They hold and change state, and they look and behave like the
   design system's version, including hover, focus, active, selected, disabled, and
   error. Operate every control yourself before calling the build done. A control you
   did not click, type into, or open is not finished.
10. **Always make sure its responsive.** Whatever you are building, a full dashboard or slide out menu. Be clever how you adapt responsively. If its a full page, then make it fits with the view. If its a slide out, then its stick to the right. If its a modal, then have it in middle center. Always think about what you are building so you can build it and align it perfectly to the user viewport screens.
<!-- FIGMA-TO-CLAUDE-CODE:END -->

