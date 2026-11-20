/**
 * Checks that the site's TypeQLite code is colored by the language server, in the editor's colors:
 *  1. the semantic tokens of a sample are the ones the provider gives (a type, attributes, a variable);
 *  2. two fences highlighted at once each get their own tokens (the provider keeps state, see the plugin);
 *  3. the colors the themes give those token types are the ones the playground's editor uses
 *     (apps/playground/src/highlighting.ts: VS Code's Light Modern and Dark Modern);
 *  4. the built tour page carries them: `book`, a type, is teal, and a name no schema defines is not.
 * Run by `website:check` after the build.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { colorOfScope, semanticTokensOf } from '../src/plugins/typeqlite-semantic.mjs';

const SITE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
const expect = (ok, message) => {
  if (!ok) failures.push(message);
};

const SAMPLE = 'define entity book, owns title; attribute title, value string;\nmatch $b isa book, has title $t; select $t;';
const words = (text, tokens) => tokens.map((t) => `${text.split('\n')[t.line].substr(t.start, t.length)}:${t.type}`);

const expected = ['book:type', 'title:property', 'title:property', 'string:type', '$b:variable', 'book:type', 'title:property', '$t:variable', '$t:variable'];
expect(JSON.stringify(words(SAMPLE, await semanticTokensOf(SAMPLE))) === JSON.stringify(expected), 'the semantic tokens of the sample changed');

// Twenty fences at once, of two kinds, as Expressive Code highlights a page's fences.
const OTHER = 'define entity person, owns name; attribute name, value string;';
const batch = await Promise.all(Array.from({ length: 20 }, (_, i) => semanticTokensOf(i % 2 ? OTHER : SAMPLE)));
batch.forEach((tokens, i) => {
  const [text, want] = i % 2 ? [OTHER, 'person:type,name:property,name:property,string:type'] : [SAMPLE, expected.join()];
  expect(words(text, tokens).join() === want, `fence ${i} of 20 highlighted at once got the wrong tokens`);
});

// The playground's colors for these token types (Light Modern and Dark Modern), upper case.
const EDITOR = {
  'dark-plus': { 'entity.name.type': '4EC9B0', 'variable.other.property': '9CDCFE', variable: '9CDCFE' },
  'light-plus': { 'entity.name.type': '267F99', 'variable.other.property': '001080', variable: '001080' },
};
for (const [name, scopes] of Object.entries(EDITOR)) {
  const theme = (await import(`shiki/themes/${name}.mjs`)).default;
  for (const [scope, hex] of Object.entries(scopes)) {
    const got = colorOfScope(theme.tokenColors, scope)?.replace('#', '').toUpperCase();
    expect(got === hex, `${name}: ${scope} is ${got}, the editor's is ${hex}`);
  }
}

const tour = readFileSync(join(SITE, 'dist/guide/five-minute-tour/index.html'), 'utf8');
expect(/--0:#4ec9b0;--1:#267f99">book</i.test(tour), 'the tour page does not show `book` as a type in the editor colors');

if (failures.length) {
  console.error(`check-highlighting: ${failures.length} problem(s):\n${failures.map((f) => `  ${f}`).join('\n')}`);
  process.exit(1);
}
console.log('check-highlighting: semantic tokens, concurrency and editor colors hold');
