// HTTP entry point. Drop-in replacement for
// references/image-proxy-playwright/src/index.js — same route shape, same
// query parameters, same status semantics, but backed by the mobile API
// crawler in ./crawl.ts (no Playwright, no Chromium).
//
// Routes (parity with the old express server):
//
//   GET  /                                -> { status: 'ok' }
//   GET  /health                          -> 200 OK
//   GET  /proxy/:folder/:fileName         -> image bytes (Cache-Control 7d)
//   GET  /characters?page=N&token=...     -> CharacterListResponse
//   GET  /v2/characters/:id?token=...&detail=true|false
//       -> Character. When detail=true and the character has allow_proxy
//          and a blank/missing personality, the hidden definition is
//          recovered via /generateAlpha and merged into the response
//          (matches the original v2 behaviour, minus the random ban-dodge
//          delay which used to live in here — kept behind isDev).
//   GET  /profiles/:id?token=...          -> CreatorProfile
//
// Notable diffs vs the old server:
//   - Old `/profiles/:id` did not require a token (the legacy /hampter
//     endpoint was public). The /mb backend always wants a bearer, so
//     `?token=...` is now required here too.
//   - Old `/characters` took `?page=` as a string; we coerce to number.
//
// Run:
//   bun run index.ts            # dev (PORT=3000)
//   PORT=8080 bun run index.ts  # custom port
//
// Set NODE_ENV=production to skip the random anti-ban delay.

import { Hono } from 'hono';
import { cors } from 'hono/cors';

import {
  getCharacter,
  getCharacterInfo,
  getCharacters,
  getCreatorProfile,
  getImageBytes,
  getImgType,
} from './crawl';

const IS_DEV = process.env.NODE_ENV !== 'production';

function randomInt(min: number, max: number): number {
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo + 1)) + lo;
}
function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const app = new Hono();
app.use('*', cors());

app.get('/', (c) => c.json({ status: 'ok' }));
app.get('/health', (c) => c.body(null, 200));

// ---------------------------------------------------------------------------
// GET /proxy/:folder/:fileName — image reverse-proxy (bot-avatars, avatars, …)
// ---------------------------------------------------------------------------
app.get('/proxy/:folder/:fileName', async (c) => {
  const { folder, fileName } = c.req.param();
  try {
    console.log({ folder, fileName });
    const { bytes, contentType } = await getImageBytes(folder, fileName);
    console.log('Content-Type', contentType);
    return new Response(bytes, {
      status: 200,
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=604800', // 7 days
      },
    });
  } catch (err) {
    console.error(err);
    return c.body(null, 404);
  }
});

// ---------------------------------------------------------------------------
// GET /characters?page=N&token=...
// ---------------------------------------------------------------------------
app.get('/characters', async (c) => {
  const token = c.req.query('token');
  const pageRaw = c.req.query('page');
  if (!token) return c.body('missing ?token', 400);
  try {
    const page = pageRaw ? Number(pageRaw) : 1;
    const result = await getCharacters(token, Number.isFinite(page) && page > 0 ? page : 1);
    return c.json(result);
  } catch (err) {
    console.error(err);
    return c.body(null, 404);
  }
});

// ---------------------------------------------------------------------------
// GET /v2/characters/:id?token=...&detail=true
// ---------------------------------------------------------------------------
app.get('/v2/characters/:id', async (c) => {
  const token = c.req.query('token');
  const getDetail = c.req.query('detail') === 'true';
  const id = c.req.param('id');
  if (!token) return c.body('missing ?token', 400);

  try {
    const character = await getCharacter(token, id);

    // Pulling hidden definitions for *every* call can flag the account; only
    // do it on explicit detail=true. Even then, only for characters whose
    // public payload had its definition stripped AND that allow proxy mode.
    if (character.id && character.allow_proxy && !character.personality && getDetail) {
      // Anti-ban jitter (same as the old server).
      if (!IS_DEV) {
        const delayTime = randomInt(0, 12_000);
        console.log(`Random delay ${delayTime} for character ${character.id}`);
        await delay(delayTime);
      }

      const characterInfo = await getCharacterInfo(
        token,
        id,
        character.chat_name || character.name,
      );
      console.log({ characterInfo });

      character.personality = characterInfo.personality;
      character.scenario = characterInfo.scenario;
      character.example_dialogs = characterInfo.example_dialogs;
      character.first_message = characterInfo.first_message;
    }

    if (!character.id) {
      console.error('Character not found or deleted!', id);
    }
    if (!character.personality && !character.allow_proxy) {
      console.warn('Character proxy not allowed, haizz!', id);
    }

    return c.json(character);
  } catch (err) {
    console.error(err);
    return c.body(null, 404);
  }
});

// ---------------------------------------------------------------------------
// GET /profiles/:id?token=...
// ---------------------------------------------------------------------------
app.get('/profiles/:id', async (c) => {
  const token = c.req.query('token');
  const id = c.req.param('id');
  if (!token) return c.body('missing ?token', 400);
  try {
    const result = await getCreatorProfile(token, id);
    return c.json(result);
  } catch (err) {
    console.error(err);
    return c.body(null, 404);
  }
});

// Re-export getImgType for any external callers that previously imported it
// off this module (mirrors crawl.js).
export { getImgType };

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

const port = Number(process.env.PORT ?? 3000);

const server = Bun.serve({
  port,
  fetch: app.fetch,
});

console.log(`Reverse proxy server is running on port ${server.port}  (NODE_ENV=${IS_DEV ? 'dev' : 'production'})`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, () => {
    console.log(`Received ${sig}. Closing server...`);
    server.stop(false);
    console.log('Server closed. Exiting process...');
    process.exit(0);
  });
}
