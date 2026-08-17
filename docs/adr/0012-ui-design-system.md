# ADR-0012: UI design system — 3D-application idiom, validated axis palette

**Status:** Accepted
**Date:** 2026-08-17
**Deciders:** Project owner (direction) + Claude (execution)

## Context

The operators of this tool already live in Blender, Cinema 4D, DaVinci Resolve,
and Nuke. Every hour spent learning a bespoke interface is an hour not spent
shooting, and on set an unfamiliar control is a safety problem, not just a
friction problem. The v0.3 UI was a functional stack of HTML fieldsets — legible,
but it read as a web form, not as a tool that belongs beside a timeline editor.

Separately, the timeline is a **three-series categorical plot** (slide / pan /
tilt). The original hand-picked colors were never checked: running the
`dataviz` validator on them showed Pan↔Tilt at **ΔE 6.6 under deuteranopia** —
below the ΔE 8 floor. A red-green colorblind operator could not reliably tell
which curve belonged to which axis. In a tool where mistaking one axis for
another moves the wrong motor, that is a defect, not a preference.

## Decision

**Adopt the professional-3D-application idiom**, expressed as CSS custom
properties in `apps/jog-slice/index.html`:

- **Neutral dark greys, never pure black, never blue-tinted** — `#131517` app
  backdrop, `#1e2124` panels, `#262a2e` raised chrome.
- **Elevation by value steps and 1px hairlines, not drop shadows.** Panels are
  separated by 1px gutters of the app background, as in Blender/Resolve.
- **Recessed inputs** (`#121416`, darker than their panel) so fields read as
  carved in — the convention that signals "editable value" in these apps.
- **Dense but breathable:** 24px panel headers in uppercase micro-type, ~12px
  body, monospace tabular numerals for every value.
- **Accent used sparingly** for active/selected state only.
- **Diamond keyframes** — the animation-software convention (Blender, After
  Effects), not circles.
- **Drag-scrub numeric fields**: click to type, drag horizontally to scrub,
  ⇧ fine ×0.1, ⌘/Ctrl coarse ×10. This is the single highest-value gesture for
  making the app feel native to this audience, and it is implemented once in
  `makeScrubbable()` and applied to every `input.num`.

**Adopt the validated categorical palette** for the three axes — dataviz
categorical slots 1–3 stepped for a dark surface:

| Axis | Hex | Slot |
|---|---|---|
| Slide | `#3987e5` | 1 (blue) |
| Pan | `#d95926` | 2 (orange) |
| Tilt | `#199e70` | 3 (aqua) |

Verified with `validate_palette.js … --mode dark --pairs all`: all checks pass
(worst-pair CVD ΔE 9.4 deutan, normal-vision ΔE 20.9, all ≥3:1 contrast).
Axis identity is additionally carried by **direct labels** on each track, never
by color alone.

## Options Considered

**A. Adopt a UI framework (React + shadcn / Tailwind).** Rejected: adds a build
step and a dependency tree to an app whose whole renderer is ~600 lines of
vanilla JS, and the resulting look is web-app, not tool-app — the opposite of
the goal.
**B. Ship the design tokens as a separate stylesheet.** Deferred: with one HTML
file, inline `:root` variables keep it greppable and diffable. Revisit if a
second window or view is added.
**C. Keep hand-picked axis colors.** Rejected — measurably fails CVD separation.

## Consequences

- New controls must use the token variables, never literal hex. Adding a color
  means adding a token.
- Any future series color must be taken from the next validated categorical slot
  and re-validated — never invented.
- The renderer now ships a **browser-preview stub** (`window.nmx` fake, installed
  only when Electron's bridge is absent) so the UI can be opened directly in a
  browser for design work, screenshots, and review without hardware or a build.
  It must never be reachable under Electron, where `window.nmx` always exists.
- Vertical space is a budget: the layout is a fixed app-bar / rail / stage /
  status-bar frame with no page scrolling. New panels go in the rail or as a
  stage section, not appended to the bottom.
