// End-to-end smoke test for crawl.ts.
//
// Exercises every exported method against the live mobile backend:
//   1. getCharacters(page=1)              — list
//   2. getCharacter(<known hidden id>)    — strips definition (server-side)
//   3. getCreatorProfile(<creator id>)    — best-effort, may not be exposed
//   4. createChatAndGetFirstMessage       — chat creation + first message
//   5. parseHiddenDefinition              — pure parser on a fixture
//   6. getCharacterInfo (proxy trick)     — recovers hidden definition
//   7. getFullExtract                     — same, returns raw payload
//
// Run:  bun test-chain.ts
// Token: ../../token.txt

import { join } from 'node:path';

import {
  createChatAndGetFirstMessage,
  getCharacter,
  getCharacterInfo,
  getCharacters,
  getCreatorProfile,
  getFullExtract,
  parseHiddenDefinition,
} from './crawl';

const KNOWN_HIDDEN_CHAR = 'ebfd93f2-5522-40bb-99ec-713719b3a0fc'; // Cienna (showdefinition=false, needs proxy trick)
const KNOWN_VISIBLE_CHAR = 'f2692fe6-27a1-4095-a878-f8b8e56e052a'; // showdefinition=true, definition served inline

const TOKEN_PATH = join(import.meta.dir, '..', 'token.txt');
const token = (await Bun.file(TOKEN_PATH).text()).trim();
if (!token) {
  console.error(`No token in ${TOKEN_PATH}`);
  process.exit(2);
}

type Result = { name: string; ok: boolean; detail: string };
const results: Result[] = [];

async function step(name: string, fn: () => Promise<string>): Promise<void> {
  process.stdout.write(`\n▶ ${name}\n`);
  const t0 = Date.now();
  try {
    const detail = await fn();
    const ms = Date.now() - t0;
    results.push({ name, ok: true, detail });
    console.log(`  ✓ ${name}  (${ms}ms)  ${detail}`);
  } catch (e) {
    const ms = Date.now() - t0;
    const detail = e instanceof Error ? e.message : String(e);
    results.push({ name, ok: false, detail });
    console.log(`  ✗ ${name}  (${ms}ms)  ${detail.slice(0, 300)}`);
  }
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

// 1. getCharacters
let pickedCreatorId: string | null = null;
await step('getCharacters(token, page=1)', async () => {
  const listing = await getCharacters(token, 1);
  assert(Array.isArray(listing.data), 'data is not an array');
  assert(listing.data.length > 0, 'empty character list');
  // Safe: length-guarded above. noUncheckedIndexedAccess doesn't track that.
  const first = listing.data[0]!;
  pickedCreatorId = first.creator_id;
  // Legacy aliases (what downstream services consume).
  assert(typeof first.allow_proxy === 'boolean', 'legacy alias allow_proxy missing on list');
  assert(typeof first.total_chat === 'number', 'legacy alias total_chat missing on list');
  assert(typeof first.total_message === 'number', 'legacy alias total_message missing on list');
  // Web/SINGLE-shaped nested `token_counts` should be synthesized from the
  // LIST-native flat `total_tokens`.
  assert(typeof first.total_tokens === 'number', 'mobile total_tokens missing');
  assert(
    first.token_counts && typeof first.token_counts.total_tokens === 'number',
    'synthesized token_counts.total_tokens missing on list',
  );
  assert(
    first.token_counts!.total_tokens === first.total_tokens,
    'token_counts.total_tokens != total_tokens',
  );
  // Mobile-native versions should still be present too.
  assert(typeof first.is_proxy_enabled === 'boolean', 'mobile is_proxy_enabled missing');
  assert(first.stats && typeof first.stats.chat === 'number', 'mobile stats.chat missing');
  return `got ${listing.data.length} chars (first: "${first.name}" by ${first.creator_name})  allow_proxy=${first.allow_proxy}  total_chat=${first.total_chat}  tokens=${first.token_counts!.total_tokens}`;
});

// 2. getCharacter on the known hidden character
let knownChar: Awaited<ReturnType<typeof getCharacter>> | null = null;
await step('getCharacter(token, KNOWN_HIDDEN_CHAR)', async () => {
  knownChar = await getCharacter(token, KNOWN_HIDDEN_CHAR);
  assert(knownChar.id === KNOWN_HIDDEN_CHAR, 'id mismatch');
  assert(knownChar.showdefinition === false, 'expected showdefinition=false');
  assert(knownChar.allow_proxy === true, 'expected allow_proxy=true');
  // Hidden definition fields should be ABSENT (matches web behavior).
  // `!knownChar.personality` is truthy for both undefined and ''.
  assert(!knownChar.personality, 'personality should be absent when hidden');
  assert(!knownChar.scenario, 'scenario should be absent when hidden');
  assert(!knownChar.example_dialogs, 'example_dialogs should be absent when hidden');
  // Legacy stat aliases on the single endpoint
  assert(typeof knownChar.total_chat === 'number', 'legacy alias total_chat missing on single');
  assert(
    typeof knownChar.total_message === 'number',
    'legacy alias total_message missing on single',
  );
  // SINGLE has nested token_counts natively (no synthesis needed)
  assert(
    knownChar.token_counts && typeof knownChar.token_counts.total_tokens === 'number',
    'token_counts.total_tokens missing on single',
  );
  // first_message should be derived from first_messages[firstNonNull]
  assert(
    typeof knownChar.first_message === 'string' && knownChar.first_message.length > 0,
    'first_message alias missing on single',
  );
  assert(Array.isArray(knownChar.first_messages), 'first_messages array missing');
  return `"${knownChar.name}"  showdef=${knownChar.showdefinition}  allow_proxy=${knownChar.allow_proxy}  total_chat=${knownChar.total_chat}  fm_len=${knownChar.first_message!.length}  tokens=${knownChar.token_counts!.total_tokens}`;
});

// 2b. getCharacter on a character whose definition is public (showdefinition=true).
// No proxy trick required — personality/scenario/example_dialogs/first_message should
// all come back inline on the SINGLE endpoint.
await step('getCharacter(token, KNOWN_VISIBLE_CHAR)', async () => {
  const visibleChar = await getCharacter(token, KNOWN_VISIBLE_CHAR);
  assert(visibleChar.id === KNOWN_VISIBLE_CHAR, 'id mismatch');
  assert(visibleChar.showdefinition === true, 'expected showdefinition=true');
  assert(
    typeof visibleChar.personality === 'string' && visibleChar.personality.length > 0,
    'personality should be present inline when showdefinition=true',
  );
  assert(
    typeof visibleChar.scenario === 'string' && visibleChar.scenario.length > 0,
    'scenario should be present inline when showdefinition=true',
  );
  assert(
    typeof visibleChar.first_message === 'string' && visibleChar.first_message.length > 0,
    'first_message should be present inline',
  );
  // example_dialogs is technically optional on the platform, but pretty common —
  // assert it's at least a string if defined.
  if (visibleChar.example_dialogs !== undefined) {
    assert(
      typeof visibleChar.example_dialogs === 'string',
      'example_dialogs must be string when set',
    );
  }
  return `"${visibleChar.name}"  showdef=${visibleChar.showdefinition}  allow_proxy=${visibleChar.allow_proxy}  personality=${visibleChar.personality!.length}  scenario=${visibleChar.scenario!.length}  example_dialogs=${visibleChar.example_dialogs?.length ?? 0}  fm=${visibleChar.first_message!.length}`;
});

// 3. getCreatorProfile (best-effort — endpoint may not exist on /mb)
await step('getCreatorProfile(token, <creator>)', async () => {
  const creatorId = knownChar?.creator_id ?? pickedCreatorId;
  assert(creatorId, 'no creator id available');
  try {
    const p = await getCreatorProfile(token, creatorId);
    return `name="${p.name ?? '(none)'}" id=${p.id}`;
  } catch (e) {
    // Mobile backend may 404 this — that's informational, not a failure
    // for the rest of the chain. Mark as a soft pass with the error text.
    const firstLine = e instanceof Error ? (e.message.split('\n')[0] ?? '') : 'unknown';
    return `not exposed via /mb (${firstLine.slice(0, 120)})`;
  }
});

// 4. createChatAndGetFirstMessage
let chatBundle: Awaited<ReturnType<typeof createChatAndGetFirstMessage>> | null = null;
await step('createChatAndGetFirstMessage(token, KNOWN_HIDDEN_CHAR)', async () => {
  chatBundle = await createChatAndGetFirstMessage(token, KNOWN_HIDDEN_CHAR);
  assert(chatBundle.chat.id, 'chat.id missing');
  assert(chatBundle.chat.character_id === KNOWN_HIDDEN_CHAR, 'character_id mismatch');
  assert(chatBundle.firstMessage, 'first message missing');
  assert(chatBundle.firstMessage.is_bot, 'first message not bot-authored');
  return `chat_id=${chatBundle.chat.id}  first_message_len=${chatBundle.firstMessage.message.length}`;
});

// 5. parseHiddenDefinition (pure, no network)
await step('parseHiddenDefinition (fixture)', async () => {
  const fixture = `
<Cienna's Persona>
Name: Cienna
Likes: green
</Cienna's Persona>

<scenario>
Cienna meets Har in class.
</scenario>

<example_dialogs>
Har: hi
Cienna: [Hello.]
</example_dialogs>
  `.trim();
  const parsed = parseHiddenDefinition(fixture, 'Cienna Iris - Mute Girl', 'Har');
  assert(parsed.personality.includes('Name: {{char}}'), 'personality not normalized');
  assert(parsed.scenario.includes('{{char}} meets {{user}}'), 'scenario not normalized');
  assert(parsed.example_dialogs.includes('{{user}}: hi'), 'example_dialogs not normalized');
  assert(
    parsed.example_dialogs.includes('{{char}}: [Hello.]'),
    'example_dialogs char not normalized',
  );
  return 'normalization OK';
});

// 6. getCharacterInfo (full proxy-mode round trip)
await step('getCharacterInfo(token, KNOWN_HIDDEN_CHAR)', async () => {
  const hidden = await getCharacterInfo(token, KNOWN_HIDDEN_CHAR);
  assert(hidden.personality.length > 200, `personality too short (${hidden.personality.length})`);
  assert(hidden.scenario.length > 50, `scenario too short (${hidden.scenario.length})`);
  assert(
    hidden.example_dialogs.length > 50,
    `example_dialogs too short (${hidden.example_dialogs.length})`,
  );
  assert(
    hidden.first_message.length > 50,
    `first_message too short (${hidden.first_message.length})`,
  );
  assert(hidden.personality.includes('{{char}}'), '{{char}} placeholder missing from personality');
  return `personality=${hidden.personality.length}  scenario=${hidden.scenario.length}  example_dialogs=${hidden.example_dialogs.length}  first_message=${hidden.first_message.length}`;
});

// 7. getFullExtract
await step('getFullExtract(token, KNOWN_HIDDEN_CHAR)', async () => {
  const res = await getFullExtract(token, KNOWN_HIDDEN_CHAR);
  assert(res.character.id === KNOWN_HIDDEN_CHAR, 'character mismatch');
  assert(res.chat.id, 'chat missing');
  assert(res.generateResponse.messages?.length, 'no messages in generate response');
  const sys = res.generateResponse.messages.find((m) => m.role === 'system');
  assert(sys, 'no system message in generate response');
  assert(res.systemMessage.length > 1000, 'system message too short');
  return `system_prompt_len=${res.systemMessage.length}  total_msgs=${res.generateResponse.messages.length}  model=${res.generateResponse.model ?? 'n/a'}`;
});

// Summary
const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\n========================================`);
console.log(`  ${passed}/${results.length} steps passed`);
if (failed) {
  console.log(`  ${failed} failed:`);
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`    - ${r.name}: ${(r.detail.split('\n')[0] ?? '').slice(0, 200)}`);
  }
}
console.log(`========================================\n`);
process.exit(failed ? 1 : 0);
