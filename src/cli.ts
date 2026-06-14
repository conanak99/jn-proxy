// Small CLI for manually exercising crawl.ts.
//
// Usage:
//   bun cli.ts                              # auto-pick a hidden+proxy char from page 1
//   bun cli.ts <characterId>                # target one character
//   bun cli.ts list [page]                  # list characters from a page
//   bun cli.ts char <characterId>           # raw character object
//
// Token is read from ./token.txt at the repo root (gitignored; see token.txt.example).

import { join } from 'node:path';
import { getCharacter, getCharacterInfo, getCharacters, getFullExtract } from './crawl';

const TOKEN_PATH = join(import.meta.dir, '..', 'token.txt');
const token = (await Bun.file(TOKEN_PATH).text()).trim();
if (!token) {
  console.error(`No token in ${TOKEN_PATH}`);
  process.exit(2);
}

const [cmd, ...rest] = Bun.argv.slice(2);

async function autoPickHiddenCharacter(): Promise<string> {
  console.log('No character id given — listing page 1 and picking a hidden+proxy candidate...');
  const listing = await getCharacters(token, 1);
  const data = listing.data ?? [];
  const candidate = data.find((c) => c.showdefinition === false && c.allow_proxy) ?? data[0];
  if (!candidate) throw new Error('Empty character listing.');
  console.log(`Picked ${candidate.name} (${candidate.id})`);
  return candidate.id;
}

async function runExtract(characterId: string): Promise<void> {
  const res = await getFullExtract(token, characterId);
  console.log(`\nCharacter: ${res.character.name}  (${res.character.id})`);
  console.log(`  showdefinition = ${res.character.showdefinition}`);
  console.log(`  allow_proxy    = ${res.character.allow_proxy}`);
  console.log(`  chat.id        = ${res.chat.id}`);
  console.log(`  system prompt length: ${res.systemMessage.length}`);
  console.log('\n================ HIDDEN DEFINITION ================');
  console.log('--- personality ---');
  console.log(res.hidden.personality || '(empty)');
  console.log('\n--- scenario ---');
  console.log(res.hidden.scenario || '(empty)');
  console.log('\n--- example_dialogs ---');
  console.log(res.hidden.example_dialogs || '(empty)');
  console.log('\n--- first_message ---');
  console.log(res.hidden.first_message || '(empty)');
  console.log('====================================================');
}

try {
  if (cmd === 'list') {
    const page = Number(rest[0] ?? '1');
    const listing = await getCharacters(token, page);
    const data = listing.data ?? [];
    console.log(`page ${page}: ${data.length} characters`);
    for (const c of data.slice(0, 20)) {
      console.log(`  ${c.id}  ${c.name}  showdef=${c.showdefinition}  proxy=${c.allow_proxy}`);
    }
  } else if (cmd === 'char') {
    const id = rest[0];
    if (!id) throw new Error('Usage: bun cli.ts char <characterId>');
    const c = await getCharacter(token, id);
    console.log(JSON.stringify(c, null, 2));
  } else if (cmd === 'hidden' && rest[0]) {
    // Returns only the parsed HiddenDefinition (mirrors crawl.js#getCharacterInfo).
    const h = await getCharacterInfo(token, rest[0]);
    console.log(JSON.stringify(h, null, 2));
  } else {
    const id = cmd && /^[0-9a-f-]{36}$/.test(cmd) ? cmd : await autoPickHiddenCharacter();
    await runExtract(id);
  }
} catch (e) {
  console.error('FATAL:', e instanceof Error ? e.stack || e.message : e);
  process.exit(1);
}
