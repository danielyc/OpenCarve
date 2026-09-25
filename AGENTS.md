# OpenCarve — guide for contributors and coding agents

OpenCarve is a browser-only CAD/CAM app for hobby CNC routers (an Easel alternative). No backend: React + TypeScript + Vite, Zustand for state, three.js for the 3D preview, Web Workers for toolpaths and simulation. Licence AGPL-3.0.

## Commands (bun)

```sh
bun install
bun run dev        # Vite dev server on http://localhost:5173 (strict port)
bun run lint       # eslint
bun run build      # tsc -b && vite build
bun run test       # Vitest unit tests (src/**/*.test.ts)
bun run test:e2e   # Playwright (Chromium); CI=1 makes it start its own server
```

A change is done only when all four of lint, build, test and test:e2e pass. If port 5173 is busy, run e2e with a temporary Playwright config on another port and delete it afterwards.

## Layout

- `src/model.ts` — the project document types, defaults, `LIMITS`, `validCut`, coordinate conventions (read the comments there first).
- `src/store.ts` — Zustand store: project, selection, tool, undo/redo (transient gestures via `beginTransient`/`commit`).
- `src/lib/` — pure helpers: geometry (shapes → polylines), fonts (glyph layout, font sources), svgImport, library (bits, materials, machines, recommended settings), projectFile (strict loader/serializer), persist (IndexedDB, autosave), units.
- `src/cam/` — toolpath planner (`toolpath.ts`: offsets, pockets, tabs, rest machining; `vcarve.ts`: medial axis), G-code writer (`gcode.ts`), worker + `useCam` hook.
- `src/preview/` — heightmap simulation (`sim.ts`, worker), 3D preview (`Preview3D.tsx`), playback timeline and bar.
- `src/canvas/Canvas.tsx` — the 2D SVG editor. `src/*Panel.tsx`, `Inspector.tsx`, `Home.tsx`, `ProjectMenu.tsx` — UI.
- `public/fonts/` — bundled OFL fonts, each with its licence file. Only unmodified upstream builds may be added.
- `e2e/` — Playwright specs and fixtures.

## Conventions and invariants

- All lengths are millimetres internally; the UI converts for inch display. Shapes and toolpaths use stock coordinates (origin at the stock's bottom-left, Y up, Z zero at the stock top); the work zero is applied only in the G-code writer and the display.
- Toolpath and G-code code is safety-critical: never change offsets, depths, tabs, cut direction, safe-Z handling or the G-code header/footer without a unit test that would fail on the old behaviour. Verify numerically (points inside region, depth ≤ intended) rather than by eye.
- The project loader is strict: every field the app writes is required, and UI setters clamp to the same `LIMITS` the loader enforces. Keep those two in sync.
- No backwards compatibility during development: when the project format changes, bump `FILE_VERSION` and reject older files; don't write migrations.
- Heavy work (planning, simulation, medial axis) runs in workers; keep the main thread free of clipper/three imports outside `preview/`.
- Prefer the smallest change that works: no speculative abstractions, few files, no comments on obvious code. Mark deliberate ceilings with a `ponytail:` comment naming the limit and the upgrade path.
- Accessibility basics are not optional: labelled controls, visible focus, keyboard reachability, no icon-only buttons without `aria-label`.
- Fonts: bundled fonts must be unmodified upstream OFL builds with their OFL text; uploaded fonts are validated with opentype.js before use.

## Process

- One commit per step or fix, with a clear message. Every commit gets a review (bugs, safety, tests, over-engineering) and the findings are fixed before moving on.
- Parallel work goes in separate git worktrees; only one agent edits the main checkout at a time.
- Docs to keep current: `README.md` (user-facing), the Status section of `PLAN.md` (steps and known limitations).
