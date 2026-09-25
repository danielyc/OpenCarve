# OpenCarve

Free, open-source (AGPL-3.0) design and toolpath software for hobby CNC routers, an alternative to Easel. It runs entirely in your browser: no account, no install, no carve limits. Your projects stay on your computer.

## Features

- **Design**: rectangle, ellipse, polygon, pen (lines and closed paths) and text tools; move, scale, rotate, align, duplicate, nudge, undo/redo.
- **Text** with 16 bundled fonts, your own uploaded TTF/OTF fonts, and Google Fonts on demand via Fontsource (see [Fonts](#fonts)); multi-line text with left/centre/right alignment and line height, letter spacing, bend (arc text) and mirror.
- **SVG import**: paths, basic shapes, transforms and groups (use Import or drop a file onto the editor).
- **Materials, bits and cut settings**: pick a material and bits; feed, plunge, stepdown and RPM are filled in with recommended values you can override.
- **Bit overrides**: adjust a library bit's diameter, and a V-bit's angle and flat tip, to match the bit you actually have. Overrides are saved in the project, marked "Custom" and can be reset; recommended settings follow the adjusted bit.
- **Machine presets**: Generic GRBL, 3018, Onefinity Woodworker, Shapeoko 4 XL/XXL, TwoTrees TTC450 (500 W), X-Carve 750/1000, or a custom work area and max RPM.
- **Selectable work zero**: put XY zero at any stock corner, the centre, or a custom offset, and Z zero at the top of the stock or its bottom (the spoilboard). The canvas marker, cursor readout, shape positions, 3D preview and G-code all follow it.
- **Cuts**: outline (outside, inside or on the path, with tabs), pocket and V-carve.
- **Two-stage carves**: a rough bit cuts outlines and clears pockets. An optional detail bit only rest-machines what the rough bit can't reach in pockets and V-carve floors; a V-bit as the detail bit also cuts the V-carves.
- **Simulate**: toolpaths on the 2D canvas, a 3D preview of the carved result, warnings and an estimated time.
- **Toolpath animation**: watch a model of the bit run the job in the 3D preview in G-code order, with play/pause, 1×–50× speed and a scrub bar, and optionally see the material removed as it goes.
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
4. **On the machine**: set XY and Z zero where the project's work zero says (Stock section, with nothing selected; the default is XY at the bottom-left corner and Z at the top of the stock). The Export step and the G-code header repeat it. For a two-bit carve, run the rough bit first, then change to the detail bit. After changing bits, re-zero Z only; don't move X or Y.

## Safety

Always check the toolpaths in the 3D preview before you carve. The recommended feeds and speeds are conservative defaults for typical hobby machines; adjust them for your machine, bits and material. Stay with the machine while it runs, and wear eye and hearing protection.

## Browser support

Tested in Chromium (Chrome, Edge); should work in Firefox and Safari. Toolpaths are computed in Web Workers; the 3D preview needs WebGL.

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

GitHub Actions runs lint, build and all tests on pushes to `main` and on pull requests (`.github/workflows/ci.yml`). `.github/workflows/pages.yml` deploys `dist/` to GitHub Pages after CI passes on `main`; it starts working once the repository is on GitHub with Settings → Pages → Source set to "GitHub Actions".

## Fonts

The font picker (Inspector → Font) searches three groups:

- **Bundled**: Roboto, Open Sans, Montserrat, Oswald (sans-serif); Lora, Source Serif 4, Merriweather, Cinzel (serif); Pacifico, Dancing Script, Great Vibes, Caveat (handwriting); Bebas Neue, Alfa Slab One, Righteous, Allerta Stencil (display/stencil). They are unmodified static Regular TTFs, from [google/fonts](https://github.com/google/fonts) or, where that only has a variable font, from the font's own project repository (for example googlefonts/opensans, JulietaUla/Montserrat, SorkinType/Merriweather, adobe-fonts/source-serif). All are licensed under the SIL Open Font License 1.1, and each font's licence is next to it in `public/fonts` (`*-OFL.txt`). Allerta Stencil covers basic Latin only; the inspector warns when a font has no glyph for a character in your text.
- **Your fonts**: upload a `.ttf` or `.otf` (up to 5 MB). It is stored in this browser (IndexedDB) and embedded in `.opencarve` files you save, so a project opens with its fonts elsewhere. A font still used by another saved project can't be removed. Make sure the font's licence allows embedding.
- **Google Fonts**: "Browse Google Fonts" loads the Google Fonts part of the [Fontsource](https://fontsource.org) index (fonts with a Latin subset, an upright Regular and an OFL, Apache 2.0 or Ubuntu Font licence; the licence is shown per font). Only the Latin subset is downloaded, so accented letters outside it show a missing-glyph warning. A chosen font is downloaded from the jsDelivr CDN and cached in IndexedDB, so it works offline after first use. Projects store only its id, so opening one on another machine needs a connection once.

## Contributing

Issues and pull requests are welcome. [PLAN.md](PLAN.md) describes the architecture decisions, the build steps and the known limitations. Please run lint and the tests before opening a pull request.

## License

[AGPL-3.0](LICENSE)
