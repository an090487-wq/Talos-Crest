# Talos Crest responsive layout audit (Phase 1)

## Scope and method

This is a static audit of the existing desktop UI. No UI code was changed and no
GUI resize testing was performed. The audit covers the application shell,
activity rail, side panes, editor container, bottom workspace panels, Talos
Canvas, Talos Calc, Architecture Explorer/Observatory, Chronicle, status bar,
and toolbar.

Sources reviewed:

- `app/index.html` — inline shell CSS and DOM.
- `app/src/ui/design-system.css` — imported by `app/src/main.ts:1`; active
  design-system rules. `app/src/styles.css` is legacy and unused.
- `app/src/main.ts` — panel/side-pane/show-hide/resize logic, persistence,
  editor creation, and word-wrap/font handling.
- `app/src/window-state.ts` — per-window storage keys.
- `app/src/terminal.ts`, `app/src/pdf.ts` — pane-specific resize behavior.
- `app/src/canvas/canvas-ui.ts`, `app/src/calc/calc-ui.ts`,
  `app/src/architecture.ts`, `app/src/chronicle.ts` — feature-view behavior.
- `app/src-tauri/tauri.conf.json` — initial desktop window dimensions.

## Overall assessment

Talos Crest already has several good responsive foundations:

- `#app` is a full-height column flex root using `100dvh`
  (`app/index.html:77-78`).
- `#workspace-body`, `#main`, `#editor-region`, and most pane bodies use
  `min-height:0`/`min-width:0`, so flex children can shrink instead of forcing
  document-level overflow.
- Document tabs and bottom-panel tabs scroll horizontally rather than wrapping.
- CodeMirror is created once and mounted into `#editor`
  (`app/src/main.ts:2146-2151`); tabs swap state instead of recreating the view.
- Canvas, Calc, Architecture Explorer, and Chronicle already have max-width
  dialogs/overlays and internal scroll containers.
- Terminal already uses an 80 ms debounced `ResizeObserver` and only sends
  `terminal_resize` when columns/rows actually change
  (`app/src/terminal.ts:107-134,274-277`).

The main weakness is **height awareness**. There is no `max-height` media query
anywhere. A fixed 280px bottom panel, a header that can wrap to four rows,
breadcrumbs, document tabs, and a multi-row footer together leave no reliable
minimum editor height in short windows. Width breakpoints exist, but they use
fixed pixel arithmetic that fails below roughly 520-600px.

## Cross-cutting root causes

1. **No height-based layout state.** All breakpoints are width-only
   (`app/index.html:520-531,537-622`; `design-system.css:874-918`). No rule
   responds to a short window or reduced vertical space.
2. **Fixed panel basis.** `#panel` is `height:280px; flex:0 0 280px`
   (`app/index.html:182`). The narrow-width cap uses `min(var(--panel-size),32vh)`
   (`:585`), but an inline `flexBasis` written by the resize handle wins over
   that cap.
3. **Persistence conflicts with adaptation.**
   - Drag can save a panel size as small as 96px (`app/src/main.ts:1140-1147`),
     but startup rewrites anything below 280px to 280px (`:2323-2326`).
   - The window resize listener only calls `syncSidePane()`
     (`app/src/main.ts:1210-1216`); it never re-clamps the panel or asks
     CodeMirror to remeasure.
4. **No app-level layout coordinator.** The only `ResizeObserver` in the shell
   watches the xterm viewport (`app/src/terminal.ts:274-277`). Architecture
   Explorer has its own `window.resize -> renderGraph` listener
   (`app/src/architecture.ts:2453`). Nothing coordinates side pane, bottom
   panel, editor measurement, and overlay geometry from one place.
5. **Fixed min widths compete with the editor.** Side panes reserve 240px and
   keep 280px for the editor (`app/src/main.ts:1095-1108,1137-1154`). Below
   about 520-600px the editor is squeezed despite `min-width:0`.
6. **Dense toolbars lack compact/overflow behavior.** Canvas, Chronicle,
   Architecture Explorer, and the app header all have many controls that rely
   on wrapping or horizontal scrolling; some have neither at the wrong size.
7. **No Tauri minimum window size.** `app/src-tauri/tauri.conf.json:12-20`
   starts at 1100x720 with no `minWidth`/`minHeight`, so the OS can create
   sizes below every breakpoint.

## Findings by area

### Main shell, toolbar, and status bar

- Header is a CSS grid (`design-system.css:378-433`) with fixed column ranges
  and 12px/6px gaps. At <=1180px columns shrink (`:874-882`), at <=900px it
  becomes four grid rows (`:884-901`), and at <=700px buttons become 40px tall
  with wrapped rows (`app/index.html:540-560`). Four rows plus a fixed bottom
  panel consume a short viewport.
- `.tc-header-actions` is a horizontal scroller
  (`design-system.css:414-425`), so actions remain reachable at narrow widths,
  but there is no explicit overflow menu.
- Activity rail is fixed 52px (184px expanded)
  (`design-system.css:449-533`) and always consumes width. Its nine 38px items
  scroll vertically at short heights. It does not auto-collapse with width.
- Status bar wraps at <=700px (`app/index.html:588-596`) with `#msg` on its own
  row. There is no max-height cap and no essential-only compact mode.
- `#panel-splitter` has `aria-valuenow="190"` (`app/index.html:788`) while the
  actual default panel height is 280px.
- PDF Focus hides the editor and side splitter entirely
  (`app/index.html:173-175`). Panel Maximize hides `#main` and the splitter but
  keeps header, breadcrumbs, document tabs, activity rail, and footer
  (`:160-162`).
- Fixed overlays cover the editor by design: market `z-index:50`, Observatory
  `60`, Canvas `80`, tab context menu `60`.

### Side panes and workspace Explorer

- Side panes use `flex:0 0 var(--side-pane-size)` with `min-width:240px`
  (`app/index.html:142-180`). Outline adds its own `min-width:220px`; HTML
  preview uses `min-width:280px`.
- `syncSidePane()` only manages the first visible side pane
  (`app/src/main.ts:1089-1113`). `previewHtml()` closes Outline but not PDF
  (`:1064-1070`), so PDF + HTML preview can be visible together and crush the
  editor.
- At <=700px `#main` becomes a column and side panes become rows with
  `min-height:160px` or `35%` (`app/index.html:561-584`). With a fixed bottom
  panel this can leave almost no editor height.
- Explorer rows are virtualized and already respond to double-click/Enter; drag
  affordances were added in the preceding increment. No layout-specific
  Explorer defects were found beyond the shared side-pane constraints.

### Editor container and CodeMirror

- One `EditorView` is mounted into `#editor` (`app/src/main.ts:2146-2151`).
  `.cm-editor { height:100% }` and `.cm-scroller { overflow:auto }`
  (`app/index.html:135-141`). `min-width:0` prevents document-level horizontal
  overflow.
- CodeMirror has its own `ResizeObserver` on `view.scrollDOM`; it debounces
  measurement by 50ms and skips resize if the last view update was under 75ms
  old. This can leave cursor/visible-range estimates stale after a panel toggle
  immediately following typing.
- Explicit `view.requestMeasure()` happens only on bottom-panel unmaximize
  (`app/src/main.ts:1038-1052`) and PDF focus change (`:2322`). `showPanel()`,
  `syncSidePane()`, window resize, and font-size changes do not request it.
- `applyEditorFontSize()` / `applyEditorFont()` (`app/src/main.ts:199-217`)
  change CSS variables that affect line height and metrics without remeasuring.
  This is the strongest concrete cursor/gutter alignment risk.
- `view.setState()` is used for tab switches, theme, language, save, and reload
  paths. `scrollTop` is restored only for tab switches and word wrap;
  `scrollLeft` is never restored (`app/src/main.ts:1369-1403,227-242,1496-1514,
  2128-2142`). With word wrap off, horizontal position can be lost.
- Per-keystroke work is already well guarded: dirty checks use length before
  full text comparison, outline/session/search work is debounced or idle, and
  no layout read/write or `requestMeasure()` runs on keystrokes. Any resize work
  added later must stay off this path.

### Bottom panels (Problems, Output, Terminal, Build, Debug Console)

- `#panel` default 280px (`app/index.html:182`). At the 96px drag minimum,
  tab strip + terminal toolbar leave the xterm view under 20px;
  `app/src/terminal.ts:111,161` then skips fitting/session start, producing a
  stuck "Starting shell…" state.
- Terminal toolbar is nowrap with a fixed 150px input and ~500-600px minimum
  content width; `#channel-terminal` has `overflow:hidden`, so Run/Clear/Restart
  can be clipped irreversibly in narrow windows
  (`design-system.css:765-805`).
- Problems rows use `white-space:pre` (`app/index.html:194`), forcing horizontal
  scrolling for long diagnostics. Output uses `pre-wrap` but not
  `overflow-wrap:anywhere` (`:190`), so long tokens can still scroll sideways.
- Build and Debug Console are static `.tc-empty` panels with `min-height:120px`
  (`design-system.css:252-268`), taller than the 96px minimum panel.
- The panel itself has no `overflow` rule; oversized non-scrolling children such
  as `#problems-toolbar` can paint outside it.
- Maximize is whole-panel, not per-channel, and keeps header/footer/tabs visible.

### Talos Canvas

- Full-screen overlay with a three-column grid
  (`app/index.html:439-445`): 72px tools, flexible viewport, 310px inspector.
  Tools, viewport, inspector, and layer list have their own scroll containers.
- No resize listener or `ResizeObserver` in `canvas-ui.ts`. `applyZoom()`
  (`canvas-ui.ts:260-268`) writes fixed pixel stage width/height. After a window
  resize the stage keeps its old size; overflow or an unnecessarily small image
  persists until the user presses Fit.
- `fitZoom()` (`:288-298`) subtracts a hardcoded 64px for hardcoded 32px
  padding and floors available space at 120px; very short viewports still
  overflow.
- Header is `flex:0 0 48px` with no wrap/overflow between 700px and 900px and
  contains about 11 controls; it can clip (`app/index.html:440`).
- Tool rail is ~700px of scrolling content in a 72px column. Inspector controls
  are fixed-width and cramped. Export dialog is always two columns.

### Talos Calc

- Dialog is `min(880px,100vw-24px)` with `max-height:min(720px,100vh-24px)`
  (`app/index.html:403,371`). `.calc-body` is a two-column grid with
  `max-height:min(620px,100vh-72px)` and `overflow:auto` (`:408-436`).
- <=700px stacks side panel under main with 44px keypad buttons
  (`app/index.html:527-531`).
- No dimension logic in `calc-ui.ts`. The `100vh-72px` hardcode conflicts with
  a wrapped narrow header; total content can exceed the dialog and clip.
- In stacked short windows the result display is not sticky; programmer and
  unit controls are below the keypad in the same scroll container.

### Architecture Explorer / Observatory

- Overlay uses `padding:3vh 3vw`, flex column, wrapped toolbar, and internal
  scrollers (`app/index.html:249-370`). Graph geometry is recomputed from
  `clientWidth/Height` in `renderGraph()` and tree renderers
  (`app/src/architecture.ts:974-1019,719-734,1130-1158,1300-1320`).
- `window.resize -> renderGraph` is already wired (`architecture.ts:2453`), but
  there is no `ResizeObserver` for pane-size changes not caused by a window
  resize.
- Fixed details pane is 270px (145px at <=700px)
  (`app/index.html:360,619`); graph width floors are 760px/300px/220px depending
  on mode. Narrow windows require horizontal scrolling and deep rows indent
  18px per level.
- At <=700px the toolbar wraps into many rows while `#arch-window` is a fixed
  flex column with `overflow:hidden`; the graph viewport can collapse to near
  zero on short windows.
- `#arch-excludes` is `display:none` at <=700px (`app/index.html:618`), so a
  function is lost rather than moved into an overflow surface.

### Chronicle

- Dialog is `min(920px,100vw-24px)` with `max-height:min(760px,100vh-24px)`
  (`design-system.css:579-591,929-938`). Results scroll vertically; rows
  ellipsize (`design-system.css:1006-1053`).
- `.tc-chronicle-stats` and `.tc-chronicle-toolbar` are nowrap flex containers
  with no overflow handling (`design-system.css:963-973`). Around <=640px their
  min-content width exceeds the dialog and clips.
- `.tc-chronicle-results` has `min-height:260px; max-height:460px`
  (`design-system.css:1006-1013`). With header/stats/toolbar/status, a short
  window forces the centered dialog past the viewport.
- No Chronicle rule appears in any media query and `chronicle.ts` performs no
  dimension reads or resize handling.

## Existing persistence to preserve

Per-window prefix `talos.window.<windowLabel>.` via
`app/src/window-state.ts:1-22`:

- `talos.panel-size`, `talos.panel-visible`, `talos.panel-maximized`
- `talos.bottom-panel-tab`, `talos.problems-severity`
- `talos.side-pane-size`, `talos.pdf-pane-size`, `talos.html-preview-size`
- `talos.outline-visible`, `talos.activity-bar-expanded`
- `talos.pdf-focus`, `talos.workspace-root`, editor session state

Global preferences include `talos.word-wrap`, `talos.editor-font-size`,
`talos.editor-font`, `talos.theme`, and `talos.restore-session`.

Any new layout persistence must remain per-window where the existing keys are
per-window, migrate safely, and never restore a size that starves the editor.

## Recommended implementation order

These are proposals only; none are implemented by this audit.

1. **Layout tokens and state controller.** Add spacing/typography/icon/control
   tokens, three explicit modes (large/medium/compact) derived from both width
   and height, and a user override. Keep it a pure module with unit tests.
2. **Safe sizing primitives.** Clamp persisted panel/side-pane sizes against the
   live viewport, reserve a minimum editor box, fix the 96px-to-280px restart
   mismatch, and clamp maximized panels against real chrome height.
3. **Coordinated resize signaling.** One rAF/ResizeObserver-based controller for
   `#app`, `#main`, `#editor`, and `#panel`; call `view.requestMeasure()` on
   panel/side-pane/font changes only, never on keystrokes. Keep terminal's own
   observer and Architecture's graph renderer, but route them through the same
   debounced signals where practical.
4. **Compact affordances.** Activity-rail auto-collapse, toolbar overflow menu,
   status-bar essentials-only mode, and a way to reach Architecture's excludes
   and terminal controls without clipping.
5. **Feature-view height fixes.** Canvas re-fit on resize, Calc header/body
   height correction, Chronicle wrapping and height relaxation.
6. **Testing.** Real GUI resize matrix at maximised, windowed, narrow, short,
   high-DPI/scaled, panel-open, multi-tab, Canvas, Calc, and restart states.

## Implementation status

The first adaptive-layout increment is implemented:

- `app/src/layout.ts` derives Large/Medium/Compact from both width and height,
  validates the per-window override, and clamps panel and side-pane sizes while
  reserving editor space.
- The status-bar **Layout** control cycles Auto/Large/Medium/Compact. Auto is the
  default and the preference is stored per window.
- Panel and side-pane sizes are clamped on restore, window resize, panel toggle,
  and pointer/keyboard resize. The requested size is stored separately from the
  temporarily clamped size, so shrinking a window does not destroy the preferred
  arrangement.
- A single `ResizeObserver` plus a rAF-coalesced window resize path drives layout
  changes. CodeMirror remeasurement is coalesced and is not called from the
  keystroke update listener.
- Compact mode wraps the terminal toolbar, relaxes Chronicle's fixed height,
  exposes Architecture Explorer exclusions, tightens chrome, and puts secondary
  toolbar actions in a **More** menu.
- Canvas now re-fits its stage on resize while it is in fit mode; manual zoom is
  preserved.
- The Tauri desktop window declares a 480x360 minimum so the compact layout has a
  defined lower bound.

Remaining limitations:

- Canvas, Calc, Architecture Explorer, and Chronicle still have view-specific
  layout constraints that were not fully redesigned.
- The new modes and overflow menu have unit/static coverage but no packaged-app
  GUI resize matrix or high-DPI measurement yet.
- No screenshot comparison, screen-reader session, or physical Windows resize
  test was performed.
- This increment does not claim complete responsiveness or bug-free behavior.
