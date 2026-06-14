// crawl.ts — Bun/TypeScript port of references/image-proxy-playwright/src/crawl.js
//
// Differences from the original:
//   - Targets the Janitor *mobile* backend (https://janitorai.com/mb/...)
//     instead of the legacy /hampter routes. Endpoint URLs were taken from the
//     React Native bundle in
//     references/janitor-ai-extracted/apk-contents/assets/webroot/index.html.
//   - The Supabase access token is *not* read from the environment or a
//     module global — every exported method takes `token` as its first
//     argument so this module is safe to call from other services that
//     already manage their own tokens.
//   - Regular Bun fetch handles every /mb/* call. The single
//     Cloudflare-WAF-gated call (POST /generateAlpha) is forwarded through
//     a tiny Python subprocess (cf-fetch.py) that uses `curl_cffi` to
//     impersonate Chrome's TLS handshake. Run `pip3 install curl_cffi` once.
//
//     Alternatives tried and rejected (see README "Why Python" section):
//       - wreq-js, impit, curl-cffi-node (Chrome 131 max) -> CF blocks
//       - impers (Chrome 142)                            -> crashes Bun (koffi/uv)
//       - playwright (real headless Chromium)            -> CF rate-limits the
//         browser session after one /generateAlpha call. Only `launch()` per
//         call works, ~3x slower than Python and 100MB heavier.
//
// Public surface (signatures match the original where reasonable):
//   getCharacters(token, page = 1)
//   getCharacter(token, characterId)
//   getCreatorProfile(token, profileId)
//   createChatAndGetFirstMessage(token, characterId)
//   getCharacterInfo(token, characterId, charName?)
//     -> returns { personality, scenario, example_dialogs, first_message }
//        even when showdefinition === false (the "hidden definition" trick)

import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { spawn as bunSpawn } from 'bun';

import type {
  Character,
  CharacterListResponse,
  Chat,
  ChatInfo,
  ChatMessage,
  CreatorProfile,
  ExtractResult,
  GenerateAlphaBody,
  GenerateAlphaResponse,
  HiddenDefinition,
  UUID,
} from './types';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MB_BASE = 'https://janitorai.com/mb';
const GEN_URL = 'https://janitorai.com/generateAlpha';

/** The web bundle version. Mobile-native uses a build hash like
 * `2026-06-02.ddf3b7c81.native`, but the web string is accepted everywhere
 * and matches the working curl example from a real browser session. */
const APP_VERSION = '9.0.27';

const UA_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36';

const SEC_CH_UA = '"Google Chrome";v="149", "Chromium";v="149", "Not)A;Brand";v="24"';

/** Single user-agent display name used inside the proxy-mode prompt. We
 * normalize it back to {{user}} after the system message is parsed. */
const PROFILE_NAME = 'Har';

/** Resolve cf-fetch.py next to this file so the package is relocatable. */
const CF_FETCH_PY = join(import.meta.dir, 'cf-fetch.py');

/** Cached path to a Python interpreter that has `curl_cffi` available. */
let _resolvedPython: string | null = null;
async function resolvePython(): Promise<string> {
  if (_resolvedPython) return _resolvedPython;
  const explicit = process.env.JANITOR_PYTHON;
  const candidates = [
    explicit,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    'python3',
  ].filter((c): c is string => Boolean(c));
  for (const cand of candidates) {
    try {
      const probe = bunSpawn({
        cmd: [cand, '-c', 'import curl_cffi'],
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const code = await probe.exited;
      if (code === 0) {
        _resolvedPython = cand;
        return cand;
      }
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'No Python interpreter with `curl_cffi` found. Install it (e.g. ' +
      '`pip3 install --break-system-packages curl_cffi`) or set JANITOR_PYTHON to ' +
      'a Python that has it. Tried: ' +
      candidates.join(', '),
  );
}

// ---------------------------------------------------------------------------
// Header helpers
// ---------------------------------------------------------------------------

function commonHeaders(
  token: string | undefined | null,
  extra: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
    'user-agent': UA_CHROME,
    origin: 'https://janitorai.com',
    referer: 'https://janitorai.com/',
    'x-app-version': APP_VERSION,
    'sec-ch-ua': SEC_CH_UA,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"macOS"',
    ...extra,
  };
  // Omit the bearer entirely when no token is provided — lets callers probe
  // public endpoints (e.g. /mb/characters listing) anonymously for
  // troubleshooting without faking a header.
  if (token) headers.authorization = `Bearer ${token}`;
  return headers;
}

async function jsonFetch<T>(
  url: string,
  init: RequestInit & { headers: Record<string, string> },
): Promise<T> {
  const r = await fetch(url, init);
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`${init.method ?? 'GET'} ${url} -> HTTP ${r.status}\n${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Non-JSON response from ${url}: ${text.slice(0, 200)}`);
  }
}

// ---------------------------------------------------------------------------
// /generateAlpha bridge (Python + curl_cffi)
// ---------------------------------------------------------------------------

interface CfFetchRequest {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}

interface CfFetchResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

async function cfFetch(req: CfFetchRequest): Promise<CfFetchResponse> {
  const python = await resolvePython();
  const proc = bunSpawn({
    cmd: [python, CF_FETCH_PY],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  proc.stdin.write(JSON.stringify(req));
  await proc.stdin.end();

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    let detail = stderr;
    try {
      const parsed = JSON.parse(stdout);
      if (parsed?.error) detail = parsed.error;
    } catch {
      /* swallow */
    }
    throw new Error(`cf-fetch.py exited ${exitCode}: ${detail.slice(0, 400)}`);
  }
  try {
    return JSON.parse(stdout) as CfFetchResponse;
  } catch {
    throw new Error(`cf-fetch.py returned non-JSON: ${stdout.slice(0, 400)}`);
  }
}

// ---------------------------------------------------------------------------
// Mobile-to-legacy field mapping
// ---------------------------------------------------------------------------
//
// We've verified by side-by-side curl that the mobile (/mb) SINGLE endpoint
// returns an IDENTICAL key set to the legacy web SINGLE endpoint — no
// translation is needed there.
//
// The LIST endpoint is intentionally sparser on mobile and renames a couple
// of fields. The aliases below cover everything we *can* synthesize from the
// LIST payload without an extra request:
//
//   Legacy / web field            Mobile LIST source            Notes
//   ----------------------------  ----------------------------  --------------------------
//   allow_proxy                   is_proxy_enabled              SINGLE has allow_proxy natively
//   total_chat                    stats.chat                    LIST + SINGLE both have stats
//   total_message                 stats.message                 LIST + SINGLE both have stats
//   token_counts.total_tokens     total_tokens (flat)           LIST only; SINGLE returns the nested form
//   first_message                 first_messages[firstNonNull]  SINGLE only (LIST has no first_messages)
//
// Fields that genuinely aren't in the LIST payload (chat_name,
// allow_published_chats, raw_avatar, scripts, obscenity_score, ...) are left
// `undefined` — synthesizing fake values would mislead consumers.
//
// Mobile-only extras kept as-is (web doesn't return them):
//   - is_image_nsfw
//   - mobileDescription
//   - public_chat_count
//   - total_tokens (flat, alongside the synthesized nested form)
//
// The definition fields (personality / scenario / example_dialogs /
// first_message) are NOT coerced to empty strings when absent — that matches
// the real web behavior (web simply omits the keys when showdefinition=false).

type AnyRecord = Record<string, unknown>;

function applyLegacyAliases<T extends AnyRecord>(obj: T): T {
  // TS 6 disallows direct dot-write on a generic constrained to an index
  // signature; alias the parameter to its constraint to keep the public
  // return type narrow while mutating through the index signature.
  const o = obj as AnyRecord;
  // is_proxy_enabled -> allow_proxy
  if (o.allow_proxy === undefined && typeof o.is_proxy_enabled === 'boolean') {
    o.allow_proxy = o.is_proxy_enabled;
  }
  // stats.{chat,message} -> total_chat / total_message
  const stats = o.stats as { chat?: number; message?: number } | undefined;
  if (stats) {
    if (o.total_chat === undefined && typeof stats.chat === 'number') {
      o.total_chat = stats.chat;
    }
    if (o.total_message === undefined && typeof stats.message === 'number') {
      o.total_message = stats.message;
    }
  }
  // LIST returns `total_tokens` flat; SINGLE / web return it nested under
  // `token_counts`. Synthesize the nested form so consumers can always read
  // `character.token_counts?.total_tokens`.
  if (o.token_counts === undefined && typeof o.total_tokens === 'number') {
    o.token_counts = { total_tokens: o.total_tokens };
  }
  // first_messages[firstNonNull] -> first_message (only meaningful on SINGLE).
  if (o.first_message === undefined && Array.isArray(o.first_messages)) {
    const first = (o.first_messages as Array<string | null>).find(
      (m) => typeof m === 'string' && m.length > 0,
    );
    if (first) o.first_message = first;
  }
  return obj;
}

/** Exposed so other services that already have a raw mobile payload can
 *  reuse the same normalization. */
export { applyLegacyAliases };

// ---------------------------------------------------------------------------
// Image proxy (ella.janitorai.com)
// ---------------------------------------------------------------------------

const IMG_TYPES: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  avif: 'image/avif',
  tiff: 'image/tiff',
  gif: 'image/gif',
};

/** Mirror of crawl.js#getImgType — maps a file extension to a content-type. */
export function getImgType(fileName: string): string {
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  return IMG_TYPES[ext] ?? 'image/jpeg';
}

/** Fetch an image from ella.janitorai.com (no auth needed, no impersonation
 *  needed). Returns the raw bytes; the HTTP server can stream them directly
 *  without a base64 round-trip (the old crawl.js base64-encoded only because
 *  Express body wrangling). */
export async function getImageBytes(
  folder: string,
  fileName: string,
): Promise<{ bytes: Uint8Array; contentType: string }> {
  const url = `https://ella.janitorai.com/${folder}/${fileName}?width=1200`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`fetch ${url} -> HTTP ${r.status}`);
  const buf = new Uint8Array(await r.arrayBuffer());
  return { bytes: buf, contentType: getImgType(fileName) };
}

// ---------------------------------------------------------------------------
// /mb/* endpoints  (bun native fetch — these pass CF on their own)
// ---------------------------------------------------------------------------

/** GET /mb/characters?page=N — paginated browse. `token` is optional so the
 *  listing can be hit anonymously (useful for `/characters` troubleshooting
 *  from a browser). When omitted, no `authorization` header is sent. */
export async function getCharacters(
  token: string | undefined | null,
  page: number = 1,
): Promise<CharacterListResponse> {
  console.log(`[crawl] list characters page=${page}${token ? '' : ' (no token)'}`);
  const url = new URL(`${MB_BASE}/characters`);
  url.searchParams.set('page', String(page));
  const resp = await jsonFetch<CharacterListResponse>(url.toString(), {
    method: 'GET',
    headers: commonHeaders(token),
  });
  if (Array.isArray(resp.data)) {
    resp.data = resp.data.map(
      (c) => applyLegacyAliases(c as unknown as AnyRecord) as unknown as typeof c,
    );
  }
  return resp;
}

/** GET /mb/characters/{characterId}. */
export async function getCharacter(token: string, characterId: UUID): Promise<Character> {
  console.log(`[crawl] view character ${characterId}`);
  const ch = await jsonFetch<Character>(`${MB_BASE}/characters/${characterId}`, {
    method: 'GET',
    headers: commonHeaders(token, {
      referer: `https://janitorai.com/characters/${characterId}`,
    }),
  });
  applyLegacyAliases(ch as unknown as AnyRecord);
  // crawl.js stripped the "created by ... on janitorai.com" footer from each
  // field; reproduce that behaviour for parity with the existing crawler.
  for (const k of ['personality', 'scenario', 'example_dialogs', 'first_message'] as const) {
    const v = (ch as Record<string, unknown>)[k];
    if (typeof v === 'string') (ch as Record<string, unknown>)[k] = removeMark(v);
  }
  return ch;
}

/** GET /mb/profiles/{profileId} — creator profile. */
export async function getCreatorProfile(token: string, profileId: UUID): Promise<CreatorProfile> {
  console.log(`[crawl] view profile ${profileId}`);
  return jsonFetch<CreatorProfile>(`${MB_BASE}/profiles/${profileId}`, {
    method: 'GET',
    headers: commonHeaders(token),
  });
}

/** POST /mb/chats — create a new chat and fetch its pre-generated first message. */
export async function createChatAndGetFirstMessage(
  token: string,
  characterId: UUID,
): Promise<{ chat: Chat; firstMessage: ChatMessage | null; chatInfo: ChatInfo }> {
  console.log(`[crawl] create chat with character ${characterId}`);

  const chat = await jsonFetch<Chat>(`${MB_BASE}/chats`, {
    method: 'POST',
    headers: commonHeaders(token, {
      'content-type': 'application/json',
      referer: `https://janitorai.com/characters/${characterId}`,
    }),
    body: JSON.stringify({ character_id: characterId }),
  });

  const chatInfo = await jsonFetch<ChatInfo>(`${MB_BASE}/chats/${chat.id}`, {
    method: 'GET',
    headers: commonHeaders(token, {
      referer: `https://janitorai.com/chats/${chat.id}`,
    }),
  });

  const firstMessage = chatInfo.chatMessages?.[0] ?? null;
  return { chat, firstMessage, chatInfo };
}

// ---------------------------------------------------------------------------
// /generateAlpha — the hidden-definition extraction trick
// ---------------------------------------------------------------------------

function buildGenerateBody(args: {
  character: Character;
  chat: Chat;
  firstMessage: ChatMessage | null;
  userId: UUID;
}): GenerateAlphaBody {
  const { character, chat, firstMessage, userId } = args;
  const nowIso = new Date().toISOString();

  const chatMessages: GenerateAlphaBody['chatMessages'] = [];
  if (firstMessage) {
    chatMessages.push({
      character_id: character.id,
      chat_id: chat.id,
      created_at: firstMessage.created_at,
      id: firstMessage.id,
      is_bot: true,
      is_main: true,
      message: firstMessage.message,
    });
  }
  chatMessages.push({
    chat_id: chat.id,
    created_at: nowIso,
    id: (firstMessage?.id ?? 0) + 1,
    is_bot: false,
    is_main: true,
    message: 'hey there',
  });

  return {
    chat: {
      character_id: character.id,
      id: chat.id,
      summary: '',
      user_id: userId,
    },
    chatMessages,
    // The shared endpoint accepts either platform value; the response body
    // shape we rely on (the OpenAI-format echo) is identical.
    clientPlatform: 'web',
    forcedPromptGenerationCacheRefetch: {
      character: false,
      chat: false,
      profile: false,
      script: false,
    },
    generateMode: 'NEW',
    generateType: 'CHAT',
    profile: { id: userId, name: PROFILE_NAME, user_name: PROFILE_NAME },
    profiles: [{ id: userId, name: PROFILE_NAME, type: 'profile', user_name: PROFILE_NAME }],
    userConfig: {
      api: 'openai',
      allow_mobile_nsfw: false,
      // proxy-mode pair: forces the server to assemble & return the prompt
      // for the client to forward to a reverse proxy. We capture that prompt
      // instead of forwarding it.
      open_ai_mode: 'proxy',
      open_ai_reverse_proxy: 'https://rentry.org/proxy',
      reverseProxyKey: 'key',
      openAIKey: null,
      openAiModel: 'gpt-4',
      open_ai_jailbreak_prompt: '',
      llm_prompt: '',
      claudeApiKey: null,
      generation_settings: {
        context_length: 16384,
        max_new_token: 500,
        temperature: 0.9,
        enable_reasoning: true,
        enable_reasoning_chat: false,
        enable_thinking: true,
        prefill_enabled: false,
        prefill_text: '',
      },
    },
  };
}

/** POST /generateAlpha (via Python+curl_cffi). Returns the assembled OpenAI prompt. */
async function callGenerateAlpha(
  token: string,
  body: GenerateAlphaBody,
  chatId: number,
): Promise<GenerateAlphaResponse> {
  const res = await cfFetch({
    method: 'POST',
    url: GEN_URL,
    headers: {
      authorization: `Bearer ${token}`,
      accept: 'text/event-stream',
      'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
      'content-type': 'application/json',
      origin: 'https://janitorai.com',
      referer: `https://janitorai.com/chats/${chatId}`,
      'user-agent': UA_CHROME,
      'sec-ch-ua': SEC_CH_UA,
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
      'x-app-version': APP_VERSION,
      'x-request-id': randomUUID(),
    },
    body: JSON.stringify(body),
    timeout: 45,
  });
  if (res.status !== 200) {
    throw new Error(`POST /generateAlpha -> ${res.status}\n${res.body.slice(0, 500)}`);
  }
  try {
    return JSON.parse(res.body) as GenerateAlphaResponse;
  } catch {
    throw new Error(
      `/generateAlpha returned non-JSON (proxy-mode is supposed to echo JSON): ${res.body.slice(0, 200)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Hidden-definition parser
// ---------------------------------------------------------------------------

/** Mirrors parser.js#parseAssistantMessageV2 but updated for the current
 *  Janitor system-prompt format which uses literal-name persona tags. */
export function parseHiddenDefinition(
  systemContent: string,
  charName: string,
  userName: string = PROFILE_NAME,
): HiddenDefinition {
  const stripped = systemContent.replace(/<system>[\s\S]*?<\/system>/g, '').trim();
  const out: HiddenDefinition = {
    personality: '',
    scenario: '',
    example_dialogs: '',
    first_message: '',
  };

  const grab = (re: RegExp): string => {
    const m = stripped.match(re);
    return m?.[1] ? m[1].trim() : '';
  };

  out.scenario = grab(/<scenario>([\s\S]*?)<\/scenario>/i);
  out.example_dialogs = grab(/<example_dialogs>([\s\S]*?)<\/example_dialogs>/i);

  // Janitor's current format wraps the persona in
  // `<{CharAlias}'s Persona>...</{CharAlias}'s Persona>` where {CharAlias} is
  // typically the character's `chat_name` (often shorter than the public
  // `name`, e.g. "Cienna" vs "Cienna Iris - Mute Girl in Your Class").
  // Discover the alias from the tag itself.
  let personaAlias = '';
  const m = stripped.match(/<([^<>/]+?)'s Persona>([\s\S]*?)<\/\1's Persona>/);
  if (m?.[1] && m[2]) {
    out.personality = m[2].trim();
    personaAlias = m[1].trim();
  } else {
    const escCharName = escapeRegex(charName);
    out.personality =
      grab(new RegExp(`<${escCharName}>([\\s\\S]*?)</${escCharName}>`)) ||
      grab(/<\{\{char\}\}'s Persona>([\s\S]*?)<\/\{\{char\}\}'s Persona>/) ||
      grab(/<\{\{char\}\}>([\s\S]*?)<\/\{\{char\}\}>/);
  }

  // Normalize literal char/user names back to {{char}}/{{user}}.
  const aliases = [charName, personaAlias].filter((s): s is string => Boolean(s));
  aliases.sort((a, b) => b.length - a.length); // longest first
  for (const key of ['personality', 'scenario', 'example_dialogs'] as const) {
    if (!out[key]) continue;
    for (const alias of aliases) {
      out[key] = out[key].split(alias).join('{{char}}');
    }
    out[key] = out[key].split(userName).join('{{user}}').trim();
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function removeMark(input: string): string {
  return input.replace(/created by .* on janitorai\.com$/g, '').trim();
}

// ---------------------------------------------------------------------------
// High-level: getCharacterInfo (mirrors crawl.js' top-level helper)
// ---------------------------------------------------------------------------

/**
 * Recovers the hidden definition for a character with `showdefinition: false`
 * by creating a fresh chat and intercepting the prompt the server assembles
 * for proxy-mode generation.
 *
 * Returns { personality, scenario, example_dialogs, first_message } so the
 * call signature matches the original crawl.js#getCharacterInfo.
 */
export async function getCharacterInfo(
  token: string,
  characterId: UUID,
  charName?: string,
): Promise<HiddenDefinition> {
  const full = await getFullExtract(token, characterId, charName);
  return full.hidden;
}

/** Same as getCharacterInfo but also returns the chat, first message, and
 *  the raw generateAlpha response — useful when consumers want to debug or
 *  preserve the full payload. */
export async function getFullExtract(
  token: string,
  characterId: UUID,
  charName?: string,
): Promise<ExtractResult> {
  const character = await getCharacter(token, characterId);
  const name = charName || character.chat_name || character.name;

  if (!character.allow_proxy) {
    console.warn(
      `[crawl] character ${characterId} has allow_proxy=false; the trick will likely fail.`,
    );
  }

  const { chat, firstMessage } = await createChatAndGetFirstMessage(token, characterId);
  const userId = (chat.user_id || firstMessage?.chat_id) as UUID; // chat.user_id is always set

  const body = buildGenerateBody({ character, chat, firstMessage, userId });
  const generateResponse = await callGenerateAlpha(token, body, chat.id);

  const systemMessage =
    generateResponse.messages?.find((m) => m.role === 'system')?.content ??
    generateResponse.messages?.[0]?.content ??
    '';
  if (!systemMessage) {
    throw new Error('/generateAlpha response had no messages[].content');
  }

  const hidden = parseHiddenDefinition(systemMessage, name);
  hidden.first_message = firstMessage?.message ?? '';

  return { character, chat, firstMessage, generateResponse, systemMessage, hidden };
}
