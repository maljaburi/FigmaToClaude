<!-- FIGMA-TO-CLAUDE-CODE:BEGIN (managed block, edits here are overwritten on the next send) -->
## Figma implementation laws

These apply to any task

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
   pattern, or token before writing a new one. Report what was reused.
5. **Never hand-draw an icon.** Icons and images ship from exported Figma assets or an
   existing project component whose glyph actually matches. No inline `<path>` you
   authored, no placeholders, no omissions.
6. **Never claim done without a visual diff.** "Looks right" is not a status. A build is
   only complete after a screenshot comparison against the Figma reference passes.
7. **Surface deviations.** Anything that intentionally differs from the design gets
   listed with a reason. Silent drift is a failure, not a shortcut.
8. **Always recheck Spacings and paddings** Always make the spacings and alignments and sizes are correct. Nothing is left just for guessing. Always compare.
9. **Everything interactive must actually work.** Toggles, checkboxes, radio buttons,
   inputs, dropdowns, tabs, and every other control ship functional — never a static
   picture of a control. They hold and change state, and they look and behave like the
   design system's version, including hover, focus, active, selected, disabled, and
   error. Operate every control yourself before calling the build done. A control you
   did not click, type into, or open is not finished.
<!-- FIGMA-TO-CLAUDE-CODE:END -->
