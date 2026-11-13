import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TypeQLiteGrammar } from '../src/generated/grammar.js';
import { grammarKeywords, TEXTMATE_OUT, typeqliteTextMate } from '../src/typeqlite-textmate.js';

/**
 * Writes the TypeQLite TextMate grammar, after `langium generate` has written `src/generated/`.
 * `langium-config.json` no longer asks Langium for one: see `typeqlite-textmate.ts` for why.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const config = JSON.parse(readFileSync(resolve(root, 'langium-config.json'), 'utf8'));
const out = resolve(root, TEXTMATE_OUT);
const grammar = typeqliteTextMate(grammarKeywords(TypeQLiteGrammar()), config.languages[0].fileExtensions);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify(grammar, null, 2)}\n`);
console.log(`Wrote the TextMate grammar to ${out}`);
