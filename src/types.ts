// Type definitions for Janitor AI's mobile backend.
//
// Sourced by reverse-engineering:
//   - The XAPK at references/Janitor+AI+-+Official+App_1.9.0_APKPure.xapk
//     (extracted to references/janitor-ai-extracted/)
//   - assets/webroot/index.html      — the React SPA the WebView loads
//   - manifest.json                  — Android package metadata
//
// Endpoint surface (relative to https://janitorai.com/mb):
//   GET    /characters?page=N                        -> CharacterListResponse
//   GET    /characters/{characterId}                 -> Character
//   POST   /chats          body { character_id }     -> Chat
//   GET    /chats/{chatId}                           -> ChatInfo
//   POST   /chats/{chatId}/messages                  -> ChatMessage[]
//   GET    /profiles/{profileId}                     -> CreatorProfile  (best-effort)
//
// Plus the shared (non-/mb) generation endpoint:
//   POST   https://janitorai.com/generateAlpha       -> GenerateAlphaResponse
//
// The "old types" requested in the README mirror the prior /hampter API
// shapes used by references/image-proxy-playwright/src/crawl.js, with the
// new fields that the mobile backend exposes today (showdefinition,
// allow_proxy, scripts, etc.).

// ---------------------------------------------------------------------------
// Common primitives
// ---------------------------------------------------------------------------

export type UUID = string;
export type Iso8601 = string;

// ---------------------------------------------------------------------------
// Character
// ---------------------------------------------------------------------------

/**
 * Lightweight character row returned by GET /mb/characters?page=N.
 *
 * The list endpoint omits the heavy fields (personality, scenario,
 * example_dialogs, first_message). For those you must hit
 * GET /mb/characters/{characterId} (which still hides them when
 * showdefinition === false unless you own the character).
 *
 * Field shape on the *mobile* (/mb) LIST backend differs from the legacy /hampter
 * shape that downstream consumers may have been built against:
 *   - `is_proxy_enabled` (mobile LIST)  vs  `allow_proxy` (legacy / mobile SINGLE)
 *   - `stats: { chat, message }`        vs  `total_chat`/`total_message`
 *   - `total_tokens` (flat)             vs  `token_counts: { total_tokens }`
 * The legacy aliases are populated by `applyLegacyAliases()` in crawl.ts on
 * the way out so old API callers keep working — both versions of each field
 * are present in the response.
 */
export interface CharacterSummary {
  id: UUID;
  name: string;
  avatar: string | null;
  description: string;
  created_at: Iso8601;
  updated_at?: Iso8601;
  first_published_at?: Iso8601 | null;
  scheduled_publish_at?: Iso8601 | null;

  creator_id: UUID;
  creator_name: string;
  creator_verified: boolean;
  creator_plusbadge: boolean;

  custom_tags: string[] | null;
  tags: { id: number; name: string; slug: string }[];

  // Mobile-native counters
  stats?: { chat: number; message: number };
  total_tokens?: number;
  public_chat_count?: number;
  /** Mobile-only short-form description used by the React Native UI. */
  mobileDescription?: string;

  // Legacy aliases (added by applyLegacyAliases)
  total_chat?: number;
  total_message?: number;
  /** Synthesized by applyLegacyAliases from `total_tokens` so the LIST shape
   *  matches what SINGLE / web return (`{ token_counts: { total_tokens } }`). */
  token_counts?: { total_tokens: number };

  // The proxy-related gating fields. When showdefinition is false the
  // definition fields are stripped from this object and from /characters/{id}
  // for anyone other than the owner — that's the scenario the extractor
  // exists to defeat.
  showdefinition?: boolean;
  is_proxy_enabled?: boolean;
  /** Legacy alias of is_proxy_enabled, added by applyLegacyAliases. */
  allow_proxy?: boolean;

  is_nsfw?: boolean;
  is_image_nsfw?: boolean;
  is_public?: boolean;
  is_deleted?: boolean;
  is_force_remove?: boolean;
  obscenity_score?: number;

  // Free-form: the API tacks on extra fields per build, so don't choke on them
  [extra: string]: unknown;
}

export interface CharacterListResponse {
  data: CharacterSummary[];
  total?: number;
  filtered_total?: number;
  size?: number;
  unique_tags?: unknown;
  top_custom_tags?: unknown;
  request_id?: string;
}

/**
 * Full character object as returned by GET /mb/characters/{characterId}.
 *
 * When `showdefinition === false` and the caller is not the owner, the four
 * "definition" fields (`personality`, `scenario`, `example_dialogs`,
 * `first_message`) are completely *absent* from the mobile response (they
 * were blank strings on the legacy /hampter endpoint). The extractor
 * recovers them via the /generateAlpha proxy trick.
 *
 * Legacy aliases added by `applyLegacyAliases()` in crawl.ts:
 *   - `total_chat` / `total_message` from `stats.chat` / `stats.message`
 *   - `first_message` from `first_messages[0]` (first non-null entry)
 *
 * The definition fields (`personality`, `scenario`, `example_dialogs`,
 * `first_message`) are left absent when the server strips them — that
 * matches the real web behavior. Use `!character.personality` to detect
 * "hidden", which is truthy for both `undefined` and an empty string.
 */
export interface Character {
  id: UUID;
  name: string;
  chat_name: string | null;
  avatar: string | null;
  raw_avatar?: string | null;
  description: string;
  created_at: Iso8601;
  updated_at?: Iso8601;
  first_published_at?: Iso8601 | null;
  scheduled_publish_at?: Iso8601 | null;
  silent_publish?: boolean | null;

  creator_id: UUID;
  creator_name: string;
  creator_verified: boolean;
  creator_plusbadge: boolean;

  custom_tags: string[] | null;
  tags?: { id: number; name: string; slug: string }[];

  is_nsfw: boolean;
  is_public: boolean;
  is_deleted?: boolean;
  is_explicit_for_anon?: boolean;
  is_force_remove?: boolean;
  obscenity_score?: number;
  text_obscenity_score?: number;

  // Proxy gating
  allow_proxy: boolean;
  allow_published_chats: boolean;
  showdefinition: boolean;
  showDefinitionOverride?: boolean;

  // Mobile-only stats
  stats?: { chat: number; message: number };
  /** Legacy alias of stats.chat, added by applyLegacyAliases. */
  total_chat?: number;
  /** Legacy alias of stats.message, added by applyLegacyAliases. */
  total_message?: number;
  token_counts?: {
    example_dialog_tokens?: number;
    first_message_tokens?: number;
    personality_tokens?: number;
    scenario_tokens?: number;
    total_tokens?: number;
  };

  // Hidden-definition fields. Absent when the server strips them
  // (`showdefinition === false` and caller is not the owner). The mobile
  // SINGLE endpoint matches web SINGLE here — both simply omit the keys.
  personality?: string;
  scenario?: string;
  example_dialogs?: string;
  first_message?: string;
  /** Mobile-native array of pre-baked greetings (the first non-null one is
   *  also exposed as `first_message` by applyLegacyAliases). */
  first_messages?: (string | null)[];

  // Scripts attached to the character
  scripts?: CharacterScript[] | null;

  // Misc mobile-only metadata
  soundcloud_track_id?: string | null;

  [extra: string]: unknown;
}

export interface CharacterScript {
  id: number | string;
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

/**
 * Response body for POST /mb/chats { character_id }.
 * Mobile chats use a numeric (Snowflake-style) ID, unlike characters.
 */
export interface Chat {
  id: number;
  character_id: UUID;
  user_id: UUID;
  persona_id?: UUID | null;
  summary?: string;
  summary_chat_id?: number | null;
  created_at: Iso8601;
  updated_at?: Iso8601;
  is_public?: boolean;
  [extra: string]: unknown;
}

/**
 * Response body for GET /mb/chats/{chatId}.
 * Contains the chat metadata and the bot's pre-generated first message.
 */
export interface ChatInfo {
  chat: Chat;
  character?: Character;
  chatMessages: ChatMessage[];
  [extra: string]: unknown;
}

export interface ChatMessage {
  id: number;
  chat_id: number;
  character_id?: UUID;
  persona_id?: UUID | null;
  is_bot: boolean;
  is_main: boolean;
  message: string;
  created_at: Iso8601;
  metadata?: Record<string, unknown> | null;
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// Profile (creator)
// ---------------------------------------------------------------------------

export interface CreatorProfile {
  id: UUID;
  name: string;
  user_name?: string;
  avatar?: string | null;
  bio?: string;
  is_verified?: boolean;
  is_plus?: boolean;
  created_at?: Iso8601;
  [extra: string]: unknown;
}

// ---------------------------------------------------------------------------
// /generateAlpha (the cross-platform generation endpoint)
// ---------------------------------------------------------------------------

export type GenerateMode =
  | 'NEW'
  | 'CONTINUE'
  | 'ALTERNATIVE'
  | 'SUGGESTION'
  | 'SUMMARY_FULL'
  | 'SUMMARY_LAST';
export type GenerateType = 'CHAT' | 'STORY';
export type ClientPlatform = 'web' | 'mobile';
export type ApiBackend = 'janitor' | 'openai' | 'claude' | 'kobold' | 'mocktest';
export type OpenAiMode = 'api_key' | 'proxy';

export interface GenerationSettings {
  context_length: number;
  max_new_token: number;
  temperature: number;
  enable_reasoning?: boolean;
  enable_reasoning_chat?: boolean;
  enable_thinking?: boolean;
  prefill_enabled?: boolean;
  prefill_text?: string;
  [extra: string]: unknown;
}

export interface UserConfig {
  api: ApiBackend;
  allow_mobile_nsfw?: boolean;
  bad_words?: string;

  // OpenAI / proxy
  openAIKey?: string | null;
  openAiModel?: string;
  open_ai_mode?: OpenAiMode;
  open_ai_jailbreak_prompt?: string;
  open_ai_reverse_proxy?: string;
  reverseProxyKey?: string | null;

  // Claude
  claudeApiKey?: string | null;
  claudeModel?: string;
  claude_jailbreak_prompt?: string;

  // Janitor / shared
  llm_prompt?: string;
  proxy_global_prompt?: string;
  generation_settings: GenerationSettings;
  text_streaming?: boolean;
}

export interface GenerateAlphaProfile {
  id: UUID;
  name: string;
  user_name: string;
  user_appearance?: string;
}

export interface GenerateAlphaPersona {
  id: UUID;
  name: string;
  type?: 'profile' | 'persona';
  user_name?: string;
  appearance?: string;
  pronouns?: string;
}

export interface GenerateAlphaBody {
  chat: {
    character_id: UUID;
    id: number;
    user_id: UUID;
    persona_id?: UUID;
    summary: string;
    summary_chat_id?: number;
  };
  chatMessages: Array<
    Partial<ChatMessage> & Pick<ChatMessage, 'chat_id' | 'is_bot' | 'is_main' | 'message'>
  >;
  clientPlatform: ClientPlatform;
  forcedPromptGenerationCacheRefetch: {
    character: boolean;
    chat: boolean;
    profile: boolean;
    script: boolean;
  };
  generateMode: GenerateMode;
  generateType: GenerateType;
  profile: GenerateAlphaProfile;
  profiles: GenerateAlphaPersona[];
  personas?: GenerateAlphaPersona[];
  suggestionMode?: string;
  suggestionPerspective?: string;
  userConfig: UserConfig;
}

/**
 * Response body when `userConfig.api === 'openai'` and
 * `userConfig.open_ai_mode === 'proxy'`. The server assembles the full
 * OpenAI-format payload (the prompt it would forward to the user's reverse
 * proxy) and returns it as JSON. The system message embeds the hidden
 * character definition — that's the whole point of the extractor.
 */
export interface GenerateAlphaResponse {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  model: string;
  temperature: number;
  max_tokens: number;
  stream?: boolean;
  debug?: unknown;
}

// ---------------------------------------------------------------------------
// Extractor output
// ---------------------------------------------------------------------------

export interface HiddenDefinition {
  personality: string;
  scenario: string;
  example_dialogs: string;
  first_message: string;
}

export interface ExtractResult {
  character: Character;
  chat: Chat;
  firstMessage: ChatMessage | null;
  /** The raw JSON the server assembled when in proxy mode. */
  generateResponse: GenerateAlphaResponse;
  /** The system message content extracted from generateResponse. */
  systemMessage: string;
  /** The parsed hidden definition. */
  hidden: HiddenDefinition;
}
