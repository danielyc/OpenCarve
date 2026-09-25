# OpenCarve — Plan

Free, open-source (AGPL-3.0) browser CAD/CAM for hobby CNC routers. Goal: Easel's
ease of use (Design → Simulate → Export) without the carve limits or paywall.

## Decisions (locked)
- v1 scope: Easel Basic parity + V-carve. No machine sender (export G-code only).
- Stack: TypeScript, Vite, React, Zustand, bun. SVG DOM for the 2D canvas, three.js for 3D preview.
- Geometry: clipper2-ts (offset/booleans), flo-mat (medial axis for V-carve), opentype.js (text). Heavy work runs in a Web Worker.
- Storage: IndexedDB autosave + `.oc` JSON files. Model kept serialisable so a sync backend can be added later.
- Units: mm internally, mm default, inch toggle. G-code: generic GRBL-compatible (G21/G90, absolute).
- UI: Easel's workflow and panel structure, original visual design. Left tool rail, 2D canvas + 3D preview, right cut-settings panel.
- Tests: Vitest for geometry + G-code, Playwright smoke test for the main flow.
- Process: each step = Opus coder agent → commit → Opus reviewer → fix → commit. Reviewer reused across related steps.

## Steps
1. **Scaffold** — bun + Vite + React + TS, Vitest, Playwright, ESLint, LICENSE (AGPL-3.0), README, app shell with three-panel layout and top Design/Simulate/Export step bar.
2. **Document model + 2D canvas** — Zustand store: project {name, units, material {w,h,thickness}, shapes[]}. Shapes: rect, ellipse, polygon, line/pen path, all stored as closed/open polylines in mm. SVG canvas with grid, pan/zoom, select, move/scale/rotate handles, delete, duplicate, align, nudge, undo/redo, property inspector (x, y, w, h, rotation).
3. **Text + SVG import** — opentype.js with 4–6 bundled OFL fonts, text shape editable in inspector; SVG file import (paths, basic shapes, transforms, groups) flattened to polylines.
4. **Materials, bits, cut settings** — bundled JSON library (materials × bits → feed, plunge, stepdown, RPM), machine panel (work area), bit picker, per-shape cut settings: type (outline outside/inside/on, fill/pocket, V-carve), depth (or through), tabs (count/size/height), roughing + detail bit.
5. **Toolpath engine (worker)** — profile offsets, pocketing by successive offsets, depth passes with stepdown, tabs, two-stage roughing/detail, ramp-free plunges; G-code emitter (safe Z, feeds, spindle, footer); time estimate. Vitest coverage.
6. **V-carve** — medial axis via flo-mat, depth from disk radius and bit angle, max-depth flat clearing, chained toolpath. Vitest coverage.
7. **3D preview** — heightmap material-removal simulation in the worker (tool cross-section stamped per move), three.js displaced mesh, toolpath lines, orbit controls, live update on settings change.
8. **Simulate + Export UI** — toolpath overlay on 2D canvas, warnings (bit larger than pocket, depth > material), G-code download, per-bit files for two-stage carves, estimated time.
9. **Persistence** — IndexedDB autosave, project list/home screen, new/open/save-as `.oc`, unit toggle persisted.
10. **Polish + smoke test** — Playwright flow (new project → rect → pocket → export), README usage docs, GitHub Pages build config.

## Status
All ten steps are done.
1. Scaffold: bun + Vite + React + TS app shell with the Design/Simulate/Export step bar; lint, Vitest and Playwright set up.
2. Document model + 2D canvas: Zustand store, SVG canvas with draw/select/transform tools, align, nudge, undo/redo, inspector.
3. Text + SVG import: 4 bundled OFL fonts via opentype.js; SVG paths, shapes, transforms and groups flattened to polylines.
4. Materials, bits, cut settings: bundled library with recommended feeds, machine presets, per-shape cuts with tabs, rough + detail bits.
5. Toolpath engine: worker-based profiles, pockets, depth passes, tabs, rough/detail rest machining, GRBL G-code, time estimate.
6. V-carve: medial-axis V-carve with flat-floor clearing by the endmill or the V-bit.
7. 3D preview: heightmap material-removal simulation in a worker, three.js mesh, toolpath lines, orbit controls.
8. Simulate + Export UI: 2D toolpath overlay, per-op list, warnings, per-bit G-code downloads, setup note.
9. Persistence: IndexedDB autosave, home screen with project list, `.oc` open/save.
10. Polish: full-flow e2e, README, CI and GitHub Pages workflows, relative build paths, tool shortcuts and shortcut help, page title.

v1.1 steps 11–14 are done too.
11. Toolpath animation: tool model on a G-code-order timeline with play/pause, speed, scrub and optional progressive material removal; the view frames the stock above the playback bar.
12. Machine preset + bit overrides: TTC450 preset; per-role diameter/angle/flat overrides; V-carve depth defaults to and the slider stops at the V-bit's max depth.
13. Text controls: letter spacing, multi-line with line height and alignment, bend, mirror.
14. Fonts: 16 bundled OFL fonts, uploaded TTF/OTF (stored in the browser and embedded in project files), Google Fonts via Fontsource.

v1.2 step 15 is done.
15. Work zero: XY zero at a stock corner, the centre or a custom offset, Z zero at the stock top or bottom; shown on the canvas, cursor readout, inspector X/Y and 3D preview (axis gizmo), applied to the G-code and stated in its header, the summary and the Export setup note. Presets follow stock resizes; a custom zero is clamped to the stock. Project files are format version 2; older versions are refused (no backwards compatibility during development).

v1.2 step 16 is done.
16. Settings step: Settings → Design → Simulate → Export; new projects open on Settings, reopened or opened files on Design. The project settings (Stock + Work zero, Machine, Bits, Material, cut settings, G-code) moved to a two-column Settings panel that takes over the 3D preview's area (the preview stays mounted, hidden); Design with nothing selected shows a summary with "Edit in Settings". Custom G-code blocks before/after the toolpaths (printable ASCII, ≤ 20 000 characters each), appended to the standard lines or replacing them, with a live preview of the rough file's first and last lines. `project.gcode` is required in project files (still version 2; files saved before this step are refused).

### Known limitations
- Text has no ligatures or complex-script shaping.
- SVG import ignores `<use>`, `<text>` and CSS styling.
- V-carve floors can show ridges of about 0.2 mm.
- No ramped entries: every depth pass plunges straight down.
- No image tracing.
- No machine sender (by design).
- Autosave is last-write-wins when the same project is open in several tabs.
- G-code uses only straight moves (no G2/G3 arcs).
- The time estimate ignores acceleration, so real jobs take longer.
- The detail bit only rest-machines pockets and V-carve floors (outlines always use the rough bit).
- Tested in Chromium only.
- Through-cut holes don't show in the 3D preview mid-playback (only in the finished result).
- Google Fonts are downloaded as the Latin subset only.
- Removing an uploaded font only checks saved projects for use, not unsaved ones open in other tabs.
- Custom G-code is emitted as typed: it isn't checked for valid commands, and with "Replace the standard header and footer" the user must provide units, spindle start/stop and program end.
- V-carve details narrower than the V-bit's flat tip are skipped, with a warning.
- A V-carve depth typed past the V-bit's max depth (or loaded from a file) is capped by the planner, with a warning.

## v1.1 — requested 2026-09-25
Decisions: animation = tool model travelling the path in the 3D preview with play/pause, speed, scrub, and a *toggle* for progressive material removal. TTC450 (500 W, 12,000 RPM, 460×460) preset. Text: letter spacing, arc text, multi-line + alignment, mirror. Bits: inline override of diameter / V angle / flat on library bits, saved in the project, "Custom" badge + reset. Fonts: ~12 more bundled OFL fonts, upload your own TTF/OTF (browser + embedded in the project file), and on-demand Google Fonts via the Fontsource TTF CDN (api.fontsource.org index, cdn.jsdelivr.net/fontsource TTF files; cached in IndexedDB).

11. **Toolpath animation** — `src/preview/` playback: tool mesh (cylinder / ball / cone by bit), timeline over all ops in G-code order using per-move times, play/pause, 1×–50× speed, scrub slider, current op highlighted; optional progressive material removal (incremental heightmap in the sim worker: stamp only newly reached moves; backwards scrub recomputes from scratch).
12. **Machine preset + bit overrides** — TTC450 500 W preset; `Bit` override fields on the project (`bitOverrides: Record<BitRole, Partial<Bit>>`), inspector fields next to each picker, recommended settings recomputed from the effective bit.
13. **Text controls** — model fields on TextShape: `letterSpacing` (mm), `lineHeight` (× size), `align` (left|center|right), `arc` (bend in degrees, 0 = straight, ± for up/down), `mirror` (boolean); layout in fonts.ts; inspector controls; SVG-import-like validation in projectFile.
14. **Fonts** — 12 more bundled OFL fonts with licence files; font sources: bundled | uploaded (IndexedDB blob + base64 in `.oc`) | fontsource (id → CDN TTF, cached in IndexedDB); font picker with search/category over the Fontsource index (fetched once, cached); text shapes store `font: string` as `bundled:id` / `upload:id` / `fs:id` (bundled ids stay backwards compatible).

## v1.2 — requested 2026-09-25
15. **Work zero** — `project.origin: { preset: 'bottom-left'|'bottom-right'|'top-left'|'top-right'|'center'|'custom'; x; y /* mm from the stock's bottom-left */; z: 'top'|'bottom' }`. Shapes stay in stock coordinates (bottom-left based); G-code subtracts the XY zero and, for Z zero = bottom, adds the stock thickness. Canvas origin marker, cursor readout and inspector X/Y are shown relative to the chosen zero; presets follow stock resizes; Export note and G-code header state the zero.
16. **Settings step + custom G-code** — step bar becomes Settings → Design → Simulate → Export. `SettingsPanel.tsx` holds Stock (incl. Work zero), Machine, Bits, Material, Rough/Detail cut settings, and a new G-code section: `project.gcode: { header: string; footer: string; replaceDefaults: boolean }` (blocks inserted before the toolpaths (after the standard header, before spindle start) and after them (after the final safe-Z move, before spindle stop); with replaceDefaults the standard header/footer lines are omitted entirely and only the user's blocks are emitted). On the Settings step the right panel widens over the 3D preview (canvas stays); on Design with nothing selected the panel shows a compact summary with an "Edit in Settings" button. New projects open on Settings; reopened ones on Design.
