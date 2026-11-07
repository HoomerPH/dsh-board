# Contributing

Thanks for taking a look at dsh-board.

## Development

```sh
npm install          # dev dependency: playwright-core (for `npm run ui`)
npm test             # offline: store, run controller, routes, tools, client bundle
node scripts/check.mjs
```

Browser suites (need a DeepSeek Harness install; `DSH_BIN` or `dsh` on PATH):

```sh
npm run e2e          # boots a throwaway profile, checks routes/SSE
npm run ui           # boots a throwaway profile, drives a real Chromium
```

`npm run ui` uses a cached Playwright Chromium. Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to a Chrome
binary if none is cached.

## Conventions

- Host changes need an offline test in `test/`; UI changes should be checkable with `npm run ui`.
- Every storage backend must keep the one-writer guard (JSON mtime/hash, SQLite revision, journal size).
- Agent tools never bypass the human merge gate; new automation must be opt-in and default off.
- Keep the package dependency-free at runtime; dev tooling belongs in `devDependencies`.

## Reporting bugs

Open an issue with: the DSH version, Node version, the storage backend, the ticket's activity excerpt,
and the relevant part of `$DSH_HOME/board/board.json` (redact secrets).
