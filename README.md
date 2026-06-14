# janitor-mobile-ts

Bun/TypeScript port of [`references/image-proxy-playwright/src/crawl.js`](../image-proxy-playwright/src/crawl.js) targeting Janitor AI's **mobile** backend (`https://janitorai.com/mb/...`) reverse-engineered from the official Android XAPK in [`references/janitor-ai-extracted/`](../janitor-ai-extracted/).

## Files

| File | Purpose |
|------|---------|
| `src/types.ts` | TypeScript shapes for `Character`, `Chat`, `ChatInfo`, `ChatMessage`, `CreatorProfile`, `GenerateAlphaBody`, `GenerateAlphaResponse`, `HiddenDefinition`, etc. |
| `src/crawl.ts` | Public methods. Every method takes `token` as its first argument so the module is safe to embed in other services. |
| `src/index.ts` | Hono-on-Bun HTTP server. Drop-in replacement for `references/image-proxy-playwright/src/index.js` — same route shape, same query params. |
| `src/cf-fetch.py` | Tiny stdin→stdout JSON shim that uses `curl_cffi` to bypass Cloudflare's TLS-fingerprint WAF on `/generateAlpha`. |
| `src/cli.ts` | Manual exerciser for the library. |
| `src/test-chain.ts` | End-to-end smoke test that hits every public method against the live backend. |
| `Dockerfile` | Production image (oven/bun:alpine + python3 + curl_cffi). |
| `pm2.config.cjs` | PM2 ecosystem file. Single app, runs through the absolute path to `bun` (per the [official PM2 + Bun guide](https://bun.com/docs/guides/ecosystem/pm2)), hourly cron restart, 512MB memory cap. No Xvfb (no Chromium anymore). |
| `deploy.sh` | Pull → `bun install` → ensure `curl_cffi` is present → `pm2 startOrRestart pm2.config.cjs`. |

## Public API (`src/crawl.ts`)

```ts
getCharacters(token, page = 1): Promise<CharacterListResponse>
getCharacter(token, characterId): Promise<Character>
getCreatorProfile(token, profileId): Promise<CreatorProfile>
createChatAndGetFirstMessage(token, characterId): Promise<{ chat, firstMessage, chatInfo }>
getCharacterInfo(token, characterId, charName?): Promise<HiddenDefinition>   // same signature as crawl.js
getFullExtract(token, characterId, charName?): Promise<ExtractResult>        // adds raw payload + chat
parseHiddenDefinition(systemContent, charName, userName?): HiddenDefinition  // pure parser
getImageBytes(folder, fileName): Promise<{ bytes, contentType }>             // for the image reverse-proxy
getImgType(fileName): string                                                 // ".png" -> "image/png" etc.
```

## HTTP Server (`src/index.ts`)

Drop-in replacement for `references/image-proxy-playwright/src/index.js`.

| Route | Notes |
|---|---|
| `GET /` | `{ status: 'ok' }` |
| `GET /health` | 200 OK |
| `GET /proxy/:folder/:fileName` | Image bytes from `ella.janitorai.com/{folder}/{fileName}?width=1200` with `Cache-Control: public, max-age=604800`. |
| `GET /characters?page=N&token=...` | Wraps `getCharacters`. |
| `GET /v2/characters/:id?token=...&detail=true` | Wraps `getCharacter`. When `detail=true` and the character has `allow_proxy=true` but a blank `personality`, the hidden definition is recovered via `/generateAlpha` and merged into the response. In production (`NODE_ENV=production`) a 0–12 s jitter delay is inserted before the extract, matching the old server's anti-ban behaviour. |
| `GET /profiles/:id?token=...` | Wraps `getCreatorProfile`. **Now requires `?token=` because the mobile profile endpoint is authed (the old `/hampter` one wasn't).** |

Run:

```bash
bun run dev      # hot-reload on port 3000
bun run start    # NODE_ENV=production on port 3000
PORT=8080 bun run start
```

## Deployment

Single-host VM with PM2 (drop-in replacement for the old playwright deploy):

```bash
# First time on the box:
#   - install bun (curl -fsSL https://bun.sh/install | bash)
#   - install pm2 (npm i -g pm2)
#   - install python3 + pip
git clone <repo> && cd janitor-mobile-ts
bash deploy.sh           # fetches branch, installs deps, curl_cffi, starts via pm2
```

Subsequent deploys: just `bash deploy.sh` on the host. The script auto-detects the checked-out branch (set `DEPLOY_BRANCH=other-branch` to override) and runs `git reset --hard origin/<branch>` exactly like the old `deploy.sh`.

Container:

```bash
docker build -t janitor-mobile-ts .
docker run -p 3000:3000 janitor-mobile-ts
```

## Why a Python subprocess

* `/mb/*` calls pass Cloudflare with stock `fetch` from Bun — no impersonation needed.
* `POST /generateAlpha` is gated by a Cloudflare WAF rule that fingerprints the TLS handshake (JA3). Bun's BoringSSL handshake and stock `curl` both get a 403. Python's [`curl_cffi`](https://github.com/lexiforest/curl_cffi) (wrapper around `libcurl-impersonate`) passes reliably with its `chrome` impersonation alias (currently Chrome 146).

`src/crawl.ts` keeps everything else in pure Bun and only shells out for that one call. End-to-end run: ~3 s for one extraction, ~1.2 s per additional extraction in the same process.

### Bun-native alternatives we tried (and why they're not used)

| Approach | Result | Notes |
|---|---|---|
| Bun `fetch` + headers | ❌ 403 | BoringSSL JA3 is recognised as automation |
| `wreq-js` (Rust/napi) | ❌ 403 | Same WAF rule blocks it |
| `impit` (Apify, Rust/napi) | ❌ Cloudflare Turnstile challenge | Only ships chrome / firefox fingerprints; CF gives them a bot-score that triggers the challenge (apify/impit#315) |
| `curl-cffi-node` (napi-rs) | ❌ Turnstile challenge | Library's newest profile is Chrome 131; CF's current rule wants Chrome 133+ extension fingerprint (`d8a2da3f94cd`). Verified against tls.peet.ws — JA4 hash mismatch. |
| `impers` (Koffi FFI to libcurl-impersonate, has Chrome 142) | ❌ Bun crashes | `koffi` calls `uv_handle_size`, an unsupported libuv function in Bun ([oven-sh/bun#18546](https://github.com/oven-sh/bun/issues/18546)). Works under Node but not Bun. |
| Real headless **Playwright** Chromium | ❌ rate-limited | First `/generateAlpha` call passes; subsequent calls from the same browser process are hard-blocked by Cloudflare ("Access Restricted") even after rotating `__cf_bm` or opening a fresh context. Only `chromium.launch()` per call works, ~3× slower than Python and a 90 MB browser download. |
| Python + `curl_cffi` subprocess | ✅ | 5 back-to-back calls all return 200 in ~1.2 s each. |

If a Bun-native binding eventually ships with `chrome146` (or whatever Cloudflare's current preferred fingerprint is) and doesn't trip Bun's libuv gap, it's a drop-in swap for `src/cf-fetch.py` since the JSON-in/JSON-out interface is tiny.

## Setup

```bash
# 1. Python helper (one-time)
pip3 install --break-system-packages curl_cffi

# 2. Bun deps (only @types/bun + typescript)
bun install
```

A valid Supabase access token must live at `./token.txt` at the repo root (gitignored — see `token.txt.example`). You can also pass it in directly to any crawl method.

## Usage

```bash
# Auto-pick a hidden+proxy character from page 1 and extract its definition
bun src/cli.ts

# Target one character
bun src/cli.ts ebfd93f2-5522-40bb-99ec-713719b3a0fc

# List page 1 (browse)
bun src/cli.ts list 1

# Print raw character JSON
bun src/cli.ts char ebfd93f2-5522-40bb-99ec-713719b3a0fc

# Print only the parsed hidden definition (parity with crawl.js#getCharacterInfo)
bun src/cli.ts hidden ebfd93f2-5522-40bb-99ec-713719b3a0fc
```

As a library:

```ts
import { getCharacterInfo, getCharacter } from './src/crawl';

const token = process.env.JANITOR_TOKEN!;
const char = await getCharacter(token, 'ebfd93f2-...');
if (!char.showdefinition) {
  const hidden = await getCharacterInfo(token, char.id);
  console.log(hidden.personality, hidden.scenario, hidden.example_dialogs);
}
```

## How the hidden-definition trick works

The /mb backend strips `personality`, `scenario`, and `example_dialogs` from `GET /mb/characters/{id}` when `showdefinition === false` and you are not the owner. But if `allow_proxy === true`, the character can be chatted with using "Proxy / OpenAI-compatible" mode, in which case:

1. The client posts the chat context to `POST /generateAlpha` with `userConfig.api === 'openai'` and `userConfig.open_ai_mode === 'proxy'`.
2. The server *assembles the full OpenAI-style payload* (`messages: [{role:'system', content: <FULL PROMPT WITH HIDDEN DEFINITION>}, …]`) and **returns it as JSON** so the client can forward it to whatever reverse proxy the user has configured.
3. We just read that JSON instead of forwarding it. The system message contains `<{CharAlias}'s Persona>…</…>`, `<Scenario>…</Scenario>`, and `<example_dialogs>…</example_dialogs>` — the parser pulls those out.
