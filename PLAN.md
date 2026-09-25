# OpenCarve — Plan

Free, open-source (AGPL-3.0) browser CAD/CAM for hobby CNC routers. Goal: Easel's
ease of use (Design → Simulate → Export) without the carve limits or paywall.

## Decisions (locked)
- v1 scope: Easel Basic parity + V-carve. No machine sender (export G-code only).
- Stack: TypeScript, Vite, React, Zustand, bun. SVG DOM for the 2D canvas, three.js for 3D preview.
- Geometry: clipper2-ts (offset/booleans), flo-mat (medial axis for V-carve), opentype.js (text). Heavy work runs in a Web Worker.
- Storage: IndexedDB autosave + `.opencarve` JSON files. Model kept serialisable so a sync backend can be added later.
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
9. **Persistence** — IndexedDB autosave, project list/home screen, new/open/save-as `.opencarve`, unit toggle persisted.
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
9. Persistence: IndexedDB autosave, home screen with project list, `.opencarve` open/save.
10. Polish: full-flow e2e, README, CI and GitHub Pages workflows, relative build paths, tool shortcuts and shortcut help, page title.

### Known limitations
- Text is single-line, with no ligatures or complex-script shaping.
- SVG import ignores `<use>`, `<text>` and CSS styling.
- V-carve floors can show ridges of about 0.2 mm.
- No ramped entries: every depth pass plunges straight down.
- No image tracing.
- No machine sender (by design).
- Autosave is last-write-wins when the same project is open in several tabs.
