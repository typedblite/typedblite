import { AstUtils, GrammarAST } from 'langium';
import { CompletionItemKind } from 'vscode-languageserver';
import { describe, expect, it } from 'vitest';
import { relationBefore } from '../src/typeqlite-completion.js';
import { TypeQLiteGrammar } from '../src/generated/grammar.js';
import { LABEL_POSITIONS } from '../src/typeqlite-labels.js';
import { workspace } from './workspace.js';

/**
 * Completion over the workspace's schema (ADR-008 D3, D5). The schema is in one file and the text
 * being completed in another, because a single-document case proves nothing about the workspace.
 */
const SCHEMA = [
  'define',
  'attribute name, value string;',
  'entity person, owns name;',
  'relation employment, relates employee, relates employer;',
  'relation contract sub employment;',
  '',
].join('\n');

/** The labels offered where `|` stands. */
async function complete(text: string) {
  const ws = await workspace({ 'schema.typeqlite': SCHEMA, 'typing.tql': text.replace('|', '') });
  const document = ws.documentOf('typing.tql');
  const list = await ws.services.TypeQLite.lsp.CompletionProvider!.getCompletion(document, {
    textDocument: { uri: document.uri.toString() },
    position: document.textDocument.positionAt(text.indexOf('|')),
  });
  return list?.items ?? [];
}
const labels = async (text: string) => (await complete(text)).map((item) => item.label);

describe('at a label position, the workspace’s definitions of the right kind', () => {
  it('after `isa`: every thing type', async () => {
    expect(await labels('match $p isa |')).toEqual(
      expect.arrayContaining(['person', 'employment', 'contract', 'name']),
    );
  });

  it('after `has`: attributes only', async () => {
    const offered = await labels('match $p isa person, has |');
    expect(offered).toContain('name');
    expect(offered).not.toContain('person');
  });

  it('in a fetch, after `$p.`: attributes only', async () => {
    const offered = await labels('match $p isa person; fetch { "n": $p.| };');
    expect(offered).toContain('name');
    expect(offered).not.toContain('person');
  });

  it('as a role player of a named relation: that relation’s roles', async () => {
    expect(await labels('match $e isa employment (|')).toEqual(
      expect.arrayContaining(['employee', 'employer']),
    );
  });

  it('as a role player of a subtype: the roles it inherits', async () => {
    expect(await labels('match $c isa contract (|')).toEqual(
      expect.arrayContaining(['employee', 'employer']),
    );
  });

  it('after `plays employment:`: that relation’s roles', async () => {
    expect(await labels('match $p plays employment:|')).toEqual(
      expect.arrayContaining(['employee', 'employer']),
    );
  });

  it('carries each definition’s kind', async () => {
    const items = await complete('match $p isa |');
    expect(items.find((item) => item.label === 'person')).toMatchObject({
      kind: CompletionItemKind.Class,
      detail: 'entity',
    });
    expect(items.find((item) => item.label === 'employment')?.kind).toBe(CompletionItemKind.Interface);
  });
});

describe('what Langium already does, now across files', () => {
  it('`owns` in a `define` offers attributes from another file', async () => {
    expect(await labels('define entity student, owns |')).toContain('name');
  });

  it('keywords are still offered where a keyword fits', async () => {
    expect(await labels('match $p |')).toContain('isa');
  });
});

describe('the relation a role belongs to, read from unfinished text', () => {
  it.each([
    ['match $p plays employment:', 'employment'],
    ['match $e isa employment (', 'employment'],
    ['match $e isa employment (employee: $p, ', 'employment'],
    ['match employment (', 'employment'],
    ['match $e isa employment, links (', 'employment'],
    ['match $e links (', undefined],
  ])('%s → %s', (text, relation) => {
    expect(relationBefore(text)).toBe(relation);
  });
});

describe('LABEL_POSITIONS', () => {
  // 🔴 Completion sees grammar rules, `sitesOf` sees AST types. If a rule or property were renamed,
  // the map would quietly stop matching, and this is what would notice.
  it.each(Object.keys(LABEL_POSITIONS))('%s names a real rule and property', (key) => {
    const [ruleName, property] = key.split('.');
    const rule = TypeQLiteGrammar().rules.find((r) => r.name === ruleName);
    expect(rule, `rule ${ruleName}`).toBeDefined();
    const assignments = AstUtils.streamAllContents(rule!).filter(GrammarAST.isAssignment);
    expect(assignments.some((a) => a.feature === property)).toBe(true);
  });
});
