import { describe, expect, it } from 'vitest';
import { validate } from './parse.js';

const messages = async (text: string) =>
  (await validate(text)).map((d) => d.message).join('\n');

describe('schema names resolve', () => {
  it('rejects `owns` naming an attribute that is not declared', async () => {
    expect(
      await messages('define entity project, owns nonexistent-attribute;'),
    ).toMatch(/nonexistent-attribute/);
  });

  it('accepts `owns` naming a declared attribute', async () => {
    expect(
      await messages(
        'define attribute project-id, value string; entity project, owns project-id @key;',
      ),
    ).toBe('');
  });

  it('rejects `plays` naming a relation that does not exist', async () => {
    expect(
      await messages(
        'define entity person, plays nonexistent-relation:member;',
      ),
    ).toMatch(/nonexistent-relation/);
  });

  it('rejects `plays` naming a role its relation does not relate', async () => {
    expect(
      await messages(
        'define relation membership, relates member; entity person, plays membership:not-a-role;',
      ),
    ).toMatch(/not-a-role/);
  });

  it('accepts `plays` naming a role a RE-OPEN added to the relation', async () => {
    // Round 1 of the Phase 01 review: the scope for a role was the `relates` traits under the
    // RelationDef alone, so `employment relates manager;` (a TypeExtensionDef — the behavior
    // spec's `undefine.feature` writes it) left a later `plays employment:manager` unresolved in
    // the editor while the runtime accepted it.
    const diagnostics = await validate(
      [
        'define',
        'relation employment, relates employee;',
        'employment relates manager;',
        'entity person, plays employment:manager;',
      ].join('\n'),
    );
    expect(diagnostics.filter((d) => d.severity === 1)).toEqual([]);
  });

  it('accepts `plays` naming a role the relation does relate', async () => {
    expect(
      await messages(
        'define relation membership, relates member; entity person, plays membership:member;',
      ),
    ).toBe('');
  });
});
