# OpenCarve

Free, open-source (AGPL-3.0) design and toolpath software for hobby CNC routers, an alternative to Easel. It runs entirely in your browser: no account, no install, no carve limits. Your projects stay on your computer.

## Features

- **Design**: rectangle, ellipse, polygon, pen (lines and closed paths) and text tools; move, scale, rotate, align, duplicate, nudge, undo/redo.
- **Text** with 4 bundled fonts (Roboto, Lora, Bebas Neue, Pacifico).
- **SVG import**: paths, basic shapes, transforms and groups (use Import or drop a file onto the editor).
- **Materials, bits and cut settings**: pick a material and bits; feed, plunge, stepdown and RPM are filled in with recommended values you can override.
- **Cuts**: outline (outside, inside or on the path, with tabs), pocket and V-carve.
- **Two-stage carves**: a rough bit clears the bulk, an optional detail bit does what the rough bit can't reach (or the V-carve).
- **Simulate**: toolpaths on the 2D canvas, a 3D preview of the carved result, warnings and an estimated time.
- **Export** G-code for GRBL-compatible machines, one file per bit.
- **Autosave** in the browser, a project list, and `.opencarve` files to save, share and back up projects.

## Not included (yet)

- **Machine control.** OpenCarve doesn't send G-code to your machine, by design. Use a sender such as [Universal Gcode Sender](https://winder.github.io/ugs_website/), [gSender](https://sienci.com/gsender/) or [CNCjs](https://cnc.js.org/).
- 3D relief carving.
- Tracing images into vectors (convert them to SVG in another tool first).

## Quick workflow

1. **Design**: set the stock size and material with nothing selected, choose your bits, draw or import shapes, and give each one a cut (outline, pocket or V-carve) and depth.
2. **Simulate**: check the toolpaths, the 3D preview and any warnings.
3. **Export**: download the G-code file for each bit.
4. **On the machine**: set Z zero at the top of the stock and XY zero at the bottom-left corner. For a two-bit carve, run the rough bit first, then change to the detail bit. After changing bits, re-zero Z only; don't move X or Y.

## Safety

Always check the toolpaths in the 3D preview before you carve. The recommended feeds and speeds are conservative defaults for typical hobby machines; adjust them for your machine, bits and material. Stay with the machine while it runs, and wear eye and hearing protection.

## Browser support

Any modern browser (Chrome, Edge, Firefox, Safari). Toolpaths are computed in Web Workers; the 3D preview needs WebGL.

## Project files

A `.opencarve` file is JSON: `{ "format": "opencarve", "version": 1, "project": { ... } }`. All lengths are in millimetres, whatever the display units.

## Development

Requires [bun](https://bun.sh).

```sh
bun install
bun run dev        # start the dev server
bun run build      # production build into dist/
bun run lint       # eslint
bun run test       # unit tests (Vitest)
bun run test:e2e   # end-to-end tests (Playwright; run `bunx playwright install chromium` once)
```

The build uses relative paths, so `dist/` can be served from any path, for example `bunx serve dist`.

GitHub Actions runs lint, build and all tests on every push and pull request (`.github/workflows/ci.yml`). `.github/workflows/pages.yml` deploys `dist/` to GitHub Pages on every push to `main`; it starts working once the repository is on GitHub with Settings → Pages → Source set to "GitHub Actions".

## Fonts

The bundled fonts in `public/fonts` are licensed under the SIL Open Font License 1.1; each font's licence is next to it (`*-OFL.txt`).

## Contributing

Issues and pull requests are welcome. [PLAN.md](PLAN.md) describes the architecture decisions, the build steps and the known limitations. Please run lint and the tests before opening a pull request.

## License

[AGPL-3.0](LICENSE)
