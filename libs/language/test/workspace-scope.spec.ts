import { AstUtils } from 'langium';
import { describe, expect, it } from 'vitest';
import { isEntityDef, isOwnsTrait, type EntityDef } from '../src/generated/ast.js';
import { workspace } from './workspace.js';

/**
 * One workspace is one schema (ADR-008 D3): a schema reference resolves into any document of the
 * workspace. Each case is built from several documents, because a single-document spec proves
 * nothing about crossing files.
 */
const UNRESOLVED = /Could not resolve reference/;

describe('schema references resolve across files', () => {
  it('`sub` names an entity another file defines', async () => {
    const ws = await workspace({
      'people.typeqlite': 'define entity person;',
      'students.typeqlite': 'define entity student sub person;',
    });
    expect(ws.messages('students.typeqlite')).toEqual([]);
  });

  it('`owns` names an attribute another file defines', async () => {
    const ws = await workspace({
      'attributes.typeqlite': 'define attribute name, value string;',
      'people.typeqlite': 'define entity person, owns name;',
    });
    expect(ws.messages('people.typeqlite')).toEqual([]);
  });

  it('`plays` names a relation, and a role it relates, from another file', async () => {
    const ws = await workspace({
      'employment.typeqlite': 'define relation employment, relates employee;',
      'people.typeqlite': 'define entity person, plays employment:employee;',
    });
    expect(ws.messages('people.typeqlite')).toEqual([]);
  });

  it('a role added by a re-open in a third file is a role of that relation', async () => {
    const ws = await workspace({
      'employment.typeqlite': 'define relation employment, relates employee;',
      'managers.typeqlite': 'define employment relates manager;',
      'people.typeqlite': 'define entity person, plays employment:manager;',
    });
    expect(ws.messages('people.typeqlite')).toEqual([]);
  });

  it('a role no file relates is still refused', async () => {
    const ws = await workspace({
      'employment.typeqlite': 'define relation employment, relates employee;',
      'people.typeqlite': 'define entity person, plays employment:manager;',
    });
    expect(ws.messages('people.typeqlite')).toEqual([
      expect.stringMatching(/RelatesTrait named 'manager'/),
    ]);
  });

  it('a label no file defines is still unresolved', async () => {
    const ws = await workspace({
      'people.typeqlite': 'define entity person, owns name;',
      'other.typeqlite': 'define attribute age, value integer;',
    });
    expect(ws.messages('people.typeqlite')).toEqual([expect.stringMatching(UNRESOLVED)]);
  });
});

describe('within one file', () => {
  // 🔴 Before ADR-008 D3 this reported a false error. A definition was a local symbol of its own
  // `define` clause, so the second clause could not see the first.
  it('a second `define` clause sees the first', async () => {
    const ws = await workspace({
      'schema.typeqlite': [
        'define attribute name, value string;',
        'define entity person, owns name;',
        'entity student sub person;',
      ].join('\n'),
    });
    expect(ws.messages('schema.typeqlite')).toEqual([]);
  });

  it('a definition in the same file wins over another file’s of the same label', async () => {
    const ws = await workspace({
      'a.typeqlite': 'define attribute name, value string;',
      'b.typeqlite': 'define attribute name, value integer; entity person, owns name;',
    });
    const b = ws.documentOf('b.typeqlite');
    const person = AstUtils.streamAllContents(b.parseResult.value).find(isEntityDef) as EntityDef;
    const owns = person.traits.find(isOwnsTrait)!;
    expect(AstUtils.getDocument(owns.attribute.ref!).uri.toString()).toBe(b.uri.toString());
  });
});

describe('the workspace changes', () => {
  it('removing the defining file turns a resolved reference into an unresolved one', async () => {
    const ws = await workspace({
      'attributes.typeqlite': 'define attribute name, value string;',
      'people.typeqlite': 'define entity person, owns name;',
    });
    expect(ws.messages('people.typeqlite')).toEqual([]);
    await ws.remove('attributes.typeqlite');
    expect(ws.messages('people.typeqlite')).toEqual([expect.stringMatching(UNRESOLVED)]);
  });

  it('adding the defining file resolves a reference that was unresolved', async () => {
    const ws = await workspace({ 'people.typeqlite': 'define entity person, owns name;' });
    expect(ws.messages('people.typeqlite')).toEqual([expect.stringMatching(UNRESOLVED)]);
    await ws.put('attributes.typeqlite', 'define attribute name, value string;');
    expect(ws.messages('people.typeqlite')).toEqual([]);
  });
});
