import { describe, expect, it } from 'vitest';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';
import { EXAMPLES } from '../src/examples';
import { runProgram } from '../src/run';

describe('the examples', () => {
  it('offers three, with distinct ids', () => {
    expect(EXAMPLES).toHaveLength(3);
    expect(new Set(EXAMPLES.map((e) => e.id)).size).toBe(3);
  });

  it.each(EXAMPLES.map((e) => [e.title, e] as const))('%s runs without an error, and answers something', (_title, example) => {
    const result = runProgram(example.source, () => new TypeDBLiteInterpreter(':memory:'));
    expect(result.error).toBeUndefined();
    expect(result.steps.filter((step) => step.error)).toEqual([]);
    expect(result.steps.some((step) => step.rows.length > 0 || step.documents.length > 0)).toBe(true);
  });

  it('people and companies joins through the relation', () => {
    const example = EXAMPLES[0]!;
    const result = runProgram(example.source, () => new TypeDBLiteInterpreter(':memory:'));
    const answer = result.steps.at(-1)!;
    expect(answer.columns).toEqual(['who', 'where']);
    expect(answer.rows).toEqual([['Alice', 'Acme'], ['Bob', 'Acme']]);
  });

  it('inheritance: animals are every dog and cat, dogs are only dogs', () => {
    const result = runProgram(EXAMPLES[1]!.source, () => new TypeDBLiteInterpreter(':memory:'));
    const [animals, dogs] = result.steps.filter((step) => step.kind === 'read');
    expect(animals!.rows.map((row) => row[1])).toEqual(['Fido', 'Rex', 'Tom']);
    expect(dogs!.rows).toEqual([['Fido'], ['Rex']]);
  });

  it('counting reduces to one row, and fetch answers JSON documents, longest first', () => {
    const result = runProgram(EXAMPLES[2]!.source, () => new TypeDBLiteInterpreter(':memory:'));
    const [counted, fetched] = result.steps.filter((step) => step.kind === 'read');
    expect(counted!.rows).toHaveLength(1);
    expect(counted!.columns).toEqual(['n', 'average', 'longest']);
    expect(counted!.rows[0]![0]).toBe('3');
    expect(fetched!.documents.map((d) => JSON.parse(d).minutes)).toEqual([45, 30, 20]);
  });
});
