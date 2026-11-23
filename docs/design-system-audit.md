# Talos Crest design system audit and refinement plan

## Goal

Make every module feel like one mature professional development product without
replacing working functionality or adding visual gimmicks.

## Audit findings

- Two styling systems coexist: inline shell CSS in `app/index.html` uses
  `--bg`, `--panel`, `--accent`, etc., while `app/src/ui/design-system.css`
  defines a parallel `.tc-*` component layer with its own tokens.
- Hardcoded colours and metrics remain in several modules, especially HTML preview,
  Canvas, Calc, Chronicle, and Architecture Explorer.
- Focus and disabled states are inconsistent; some controls rely on browser
  defaults.
- Empty, loading, warning, and error states vary by module.
- Spacing and control heights are mostly tokenised in the shell, but module CSS
  still uses ad-hoc values.
- Responsive behaviour has recently been added for the shell, but module-specific
  layouts (Canvas, Calc, Chronicle, Architecture Explorer) still need review.

## Incremental plan

### Increment 1 — shared interaction baseline (implemented)

- Add consistent `:focus-visible`, hover, active, and disabled states to shared
  buttons, inputs, selects, and menu items.
- Ensure toast, empty, and status text use semantic colour tokens.
- Keep all motion within `--transition-fast` and avoid layout-affecting animation.

### Increment 2 — token consolidation

- Move module-specific colours into the shared token set.
- Remove hardcoded `#fff`, `#000`, and accent values from module CSS.
- Document token usage in `app/README.md`.

### Increment 3 — module polish

- Apply the shared layout and interaction rules to Chronicle, Canvas, Calc, PDF,
  terminal, and Architecture Explorer.
- Add professional empty/loading/error states to each module.

### Increment 4 — verification

- Add static tests for shared component states.
- Run type checks, tests, builds, and a manual window-size matrix.
- Record remaining gaps honestly.

## Rules

- No new dependencies.
- No expensive background rendering.
- No changes to typing or workspace scan performance.
- Preserve all existing functionality.
}