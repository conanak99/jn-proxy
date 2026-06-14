# AGENTS.md

Project guide for AI coding agents working on this repo. Read this before making changes.

## What this is

`janitor-mobile-ts` — a Bun + TypeScript reverse-proxy that wraps Janitor AI's mobile
backend (`https://janitorai.com/mb/...`) so other services can call simple HTTP routes
without dealing with auth, Cloudflare TLS fingerprinting, or the hidden-definition
extraction trick. Drop-in replacement for the older Playwright-based `image-proxy-playwright`
service — no browser, no Chromium.

## Stack

- **Runtime**: Bun (>= 1.3). The `.cursor/rules/use-bun-instead-of-node-vite-npm-pnpm.mdc`
  rule applies — prefer Bun APIs over Node.js (`Bun.serve`, `Bun.file`, `Bun.spawn`, etc.)
  and never reach for `npm`/`vite`/`webpack`/`ts-node`/`dotenv`.
- **HTTP**: Hono on `Bun.serve`.
- **TLS bypass**: A tiny Python (`src/cf-fetch.py`) + `curl_cffi` subprocess for the *one*
  endpoint Cloudflare's JA3 rule blocks (`POST /generateAlpha`). Everything else uses
  native `fetch`. Do not reintroduce Playwright or Chromium — see README "Why Python".
- **Lint/format**: Biome 2.5 (`biome.json`).
- **Typecheck**: `tsc --noEmit` with `noUncheckedIndexedAccess: true` and `strict: true`.

## Layout

```
src/
  index.ts        Hono routes; entrypoint for the HTTP server
  crawl.ts        Public methods (every method takes `token` as first arg)
  cli.ts          Manual exerciser (bun run extract)
  test-chain.ts   End-to-end live integration test (bun run test)
  types.ts        Mobile backend type shapes
  cf-fetch.py     Python+curl_cffi shim (stdin JSON in, stdout JSON out)
biome.json        Lint/format config
tsconfig.json     Strict TS, noEmit, noUncheckedIndexedAccess
pm2.config.cjs    Production process manager config
deploy.sh         Pull → bun install → ensure curl_cffi venv → pm2 restart
token.txt         (gitignored) Supabase access token used by cli.ts / test-chain.ts
token.txt.example Empty template; copy to token.txt to enable local testing
```

## Commands

| Command | What it does |
|---|---|
| `bun run dev` | Hot-reload server on port 3000 |
| `bun run start` | `NODE_ENV=production` server on port 3000 |
| `bun run extract [id]` | CLI: extract hidden definition for a character |
| `bun run test` | Live integration test against the real backend (needs `./token.txt`) |
| `bun run lint` | Biome lint (read-only) |
| `bun run format` | Biome format & write |
| `bun run check` | Biome lint + format check + import sort (read-only) |
| `bun run check:fix` | Same, applies safe auto-fixes |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run verify` | `check` + `typecheck` — run this before finishing any task |

## Setup

1. `bun install`
2. Drop a valid Supabase access token at `./token.txt` (gitignored). Without it,
   `bun run test` and `bun run extract` cannot reach the backend.
3. `pip3 install curl_cffi` (or let `deploy.sh` create a venv on the prod box).

## Verifying changes

Before reporting a task done, run `bun run verify`. It must exit 0. If you touched
backend interaction code (`src/crawl.ts`, `src/index.ts`), also run `bun run test`
and confirm 8/8 steps pass.

## Code style

Biome enforces formatting (single quotes, trailing commas, semicolons, 100-col, 2-space
LF). Don't fight it — run `bun run check:fix` if your edits diverge.

A few intentional choices baked into `biome.json`:
- `noNonNullAssertion: off` — `src/test-chain.ts` uses `!` deliberately after manual
  `assert(...)` checks where TS's flow analysis can't propagate across
  `Awaited<...> | null` variables.
- `noExplicitAny: warn` — discouraged but not blocking.

## Project invariants & gotchas

- **Every public method takes `token` as the first argument.** Do not introduce a
  module-level token global; keeps the library safe to embed in services that manage
  their own auth.
- **`/characters` accepts an optional token.** When omitted, no `authorization` header
  is sent upstream — used for browser-based troubleshooting. Other routes
  (`/v2/characters/:id`, `/profiles/:id`) still require `?token=` because their
  upstream endpoints reject anonymous calls.
- **Hidden-definition extraction (the "proxy trick") only works when
  `character.allow_proxy === true`** and `showdefinition === false`. The server
  refuses to assemble the prompt otherwise.
- **`/generateAlpha` must go through `cf-fetch.py`.** Bun's native fetch and stock curl
  both get a 403 (JA3 fingerprint). `curl_cffi` impersonates Chrome's ClientHello.
  Don't try wreq-js, impit, curl-cffi-node, or impers — README documents why each fails.
- **`commonHeaders(token)` omits the `authorization` header when `token` is falsy.**
  Do not send `Bearer ` (empty bearer) — Cloudflare flags it.
- **`applyLegacyAliases` mutates through `obj as AnyRecord`.** TS 6 disallows dot-write
  on a generic constrained to an index signature. The internal `const o = obj as
  AnyRecord` alias is intentional; keep the public generic for return-type narrowing.
- **`noUncheckedIndexedAccess` is on.** Index accesses return `T | undefined`. Use
  `?.[k]`, `arr[0]!` (with a comment explaining why), or `?? defaultValue`.

## Deployment

`bash deploy.sh` on the prod box:
1. `git reset --hard origin/$(current branch)`
2. `bun install --frozen-lockfile --production`
3. Pre-flights `python3 -c 'import ensurepip'`. On Debian/Ubuntu fresh boxes, install
   `python3.X-venv` first (the script prints the exact apt command).
4. Creates `./venv/` with pinned `curl_cffi==0.15.0`.
5. Exports `JANITOR_PYTHON=$PWD/venv/bin/python3` so `pm2.config.cjs` picks it up.
6. `pm2 startOrRestart pm2.config.cjs --update-env && pm2 save`.

## Things NOT to do

- Don't add Playwright, Puppeteer, or headless Chromium — they're rate-limited by
  Cloudflare and were the reason for the rewrite.
- Don't use `dotenv` — Bun loads `.env` automatically.
- Don't use `npm`, `yarn`, or `pnpm` commands. Use Bun.
- Don't commit `token.txt` (it's gitignored; double-check before staging).
- Don't `git push --force` to `master`.
- Don't introduce `any` casually — prefer narrowing via `unknown` + type guards.
