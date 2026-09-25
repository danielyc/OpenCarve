# OpenCarve

Free, open-source browser design and toolpath software for hobby CNC routers — an alternative to Easel. Design in 2D, preview the carve in 3D, export GRBL-compatible G-code.

**Status:** early development. Not usable yet.

## Development

Requires [bun](https://bun.sh).

```sh
bun install
bun run dev        # start the dev server
bun run build      # production build
bun run lint       # eslint
bun run test       # unit tests (Vitest)
bun run test:e2e   # smoke test (Playwright; run `bunx playwright install chromium` once)
```

## License

[AGPL-3.0](LICENSE)
