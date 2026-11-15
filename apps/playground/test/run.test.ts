import { describe, expect, it, vi } from 'vitest';
import { TypeDBLiteInterpreter } from '@typedblite/runtime';
import { MAX_ROWS, parseProgram, runProgram, type Engine } from '../src/run';

const open = () => new TypeDBLiteInterpreter(':memory:');
const run = (source: string) => runProgram(source, open);

const SCHEMA = 'define attribute name, value string; entity person, owns name @key;';

describe('splitting a program into statements', () => {
  it('reads each clause with its kind and the line it starts on', () => {
    const program = parseProgram(`# a comment
define attribute name, value string; entity person, owns name @key;

insert $p isa person, has name "Ann";
end;
match $p isa person; select $p;
`);
    if ('error' in program) throw new Error(program.error.message);
    expect(program.clauses.map((c) => [c.kind, c.line])).toEqual([
      ['define', 2],
      ['write', 4],
      ['read', 6],
    ]);
  });

  it('classifies undefine and redefine as schema statements', () => {
    const program = parseProgram('define attribute email, value string; entity person, owns email;\nundefine owns email from person;\nredefine attribute email value integer;');
    if ('error' in program) throw new Error(program.error.message);
    expect(program.clauses.map((c) => c.kind)).toEqual(['define', 'define', 'define']);
  });

  it('classifies a pipeline by its stages: put, update and delete write, a bare match reads', () => {
    const program = parseProgram(`match $p isa person; select $p;
end;
match $p isa person; delete $p;
end;
match $p isa person, has name $n; update $p has name "X";
end;
put $p isa person, has name "Y";
end;
match $p isa person;`);
    if ('error' in program) throw new Error(program.error.message);
    expect(program.clauses.map((c) => c.kind)).toEqual(['read', 'write', 'write', 'write', 'read']);
  });

  it('refuses a program with a syntax error as a whole, naming the line', () => {
    const result = run(`${SCHEMA}\ninsert $p isa person, has name "A";\nend;\nmatch $p isa ;`);
    expect(result.steps).toEqual([]);
    expect(result.error?.line).toBe(4);
    expect(result.error?.message).toBeTruthy();
  });

  it('refuses a statement cut off at the end of the program, on the line where it stopped', () => {
    // No position for the end of the input, so the error is placed at the last token before it.
    const result = run(`${SCHEMA}\n\nmatch $p isa person`);
    expect(result.steps).toEqual([]);
    expect(result.error?.line).toBe(3);
  });

  it('refuses a character the lexer cannot read, with the line it is on', () => {
    const result = run(`${SCHEMA}\n\n\u0001`);
    expect(result.steps).toEqual([]);
    expect(result.error?.line).toBe(3);
  });

  it('runs nothing, not even the schema, when a later line is wrong', () => {
    const engine = vi.fn(open);
    const result = runProgram(`${SCHEMA}\nmatch $x isa ;`, engine);
    expect(result.error).toBeDefined();
    expect(engine).not.toHaveBeenCalled();
  });
});

describe('running a program', () => {
  it('runs a schema, a write and a read in order, against one database', () => {
    const result = run(`${SCHEMA}
insert $a isa person, has name "Ann"; $b isa person, has name "Bob";
end;
match $p isa person, has name $n; select $n; sort $n;`);
    expect(result.error).toBeUndefined();
    expect(result.steps.map((s) => s.kind)).toEqual(['define', 'write', 'read']);
    const read = result.steps[2]!;
    expect(read.columns).toEqual(['n']);
    expect(read.rows).toEqual([['Ann'], ['Bob']]);
  });

  it("reports the engine's facts: what a write wrote, what a schema did", () => {
    const [define, write] = run(`${SCHEMA}\ninsert $a isa person, has name "Ann";`).steps;
    expect(define!.notes.join(' ')).toMatch(/applied \d+ new definition/);
    expect(write!.notes.join(' ')).toMatch(/wrote/i);
  });

  it('explains an empty answer rather than showing a bare nothing', () => {
    const read = run(`${SCHEMA}\nmatch $p isa person; select $p;`).steps[1]!;
    expect(read.rows).toEqual([]);
    expect(read.notes.join(' ')).toMatch(/candidate/);
  });

  it('answers a fetch as pretty-printed JSON documents', () => {
    const read = run(`${SCHEMA}
insert $a isa person, has name "Ann";
end;
match $p isa person, has name $n; fetch { "who": $n };`).steps[2]!;
    expect(read.rows).toEqual([]);
    expect(read.documents).toEqual([JSON.stringify({ who: 'Ann' }, null, 2)]);
  });

  it('shows a write that ends in a select, as the engine answers it', () => {
    const write = run(`${SCHEMA}\ninsert $a isa person, has name "Ann";\nselect $a;`).steps[1]!;
    expect(write.kind).toBe('write');
    expect(write.rows).toHaveLength(1);
  });

  it('fills a cell the answer lacks with an empty string, across rows with different columns', () => {
    const engine: Engine = {
      hasSchema: true,
      define: () => ({ diagnostics: [] }),
      execute: () => ({ rows: [], diagnostics: [] }),
      query: () => ({ rows: [{ a: { toString: () => '1' } }, { b: { toString: () => '2' } }], diagnostics: [] }),
      close: () => undefined,
    };
    const step = runProgram('match $x isa y;', () => engine).steps[0]!;
    expect(step.columns).toEqual(['a', 'b']);
    expect(step.rows).toEqual([['1', ''], ['', '2']]);
  });

  it("reads a diagnostic message that is markup, as well as one that is a string", () => {
    const engine: Engine = {
      hasSchema: true,
      define: () => ({ diagnostics: [] }),
      execute: () => ({ rows: [], diagnostics: [] }),
      query: () => ({ rows: [], diagnostics: [{ message: 'plain' }, { message: { value: 'marked up' } }] }),
      close: () => undefined,
    };
    expect(runProgram('match $x isa y;', () => engine).steps[0]!.notes).toEqual(['plain', 'marked up']);
  });

  it('closes the database when it is done, and when a statement fails', () => {
    const close = vi.fn();
    const engine = (query: Engine['query']): Engine => ({
      hasSchema: true,
      define: () => ({ diagnostics: [] }),
      execute: () => ({ rows: [], diagnostics: [] }),
      query,
      close,
    });
    runProgram('match $x isa y;', () => engine(() => ({ rows: [], diagnostics: [] })));
    runProgram('match $x isa y;', () => engine(() => { throw new Error('boom'); }));
    expect(close).toHaveBeenCalledTimes(2);
  });
});

describe('a statement that fails', () => {
  it('stops the program there, and reports the error with its line', () => {
    const result = run(`${SCHEMA}
insert $a isa person, has name "Ann";
end;
insert $b isa person, has name "Ann";
end;
match $p isa person; select $p;`);
    expect(result.steps.map((s) => s.kind)).toEqual(['define', 'write', 'write']);
    const failed = result.steps[2]!;
    expect(failed.error?.message).toMatch(/\[CNT9\]|unique|key/i);
    expect(failed.error?.line).toBe(4);
  });

  it('places an error on the line inside a multi-line statement that the engine points at', () => {
    const result = run(`${SCHEMA}
insert
  $a isa person, has name "Ann";
  $b isa nobody;`);
    const failed = result.steps[1]!;
    expect(failed.error?.message).toMatch(/nobody/);
    expect(failed.error?.line).toBeGreaterThanOrEqual(2);
    expect(failed.error?.line).toBeLessThanOrEqual(4);
  });

  it('says a schema is needed when a statement comes before any define, not "no such table"', () => {
    const result = run('insert $a isa person;');
    const failed = result.steps[0]!;
    expect(failed.error?.message).toMatch(/No schema has been applied/);
    expect(failed.error?.message).not.toMatch(/no such table/);
    expect(failed.error?.line).toBe(1);
  });

  it('reports a thrown value that is not an Error', () => {
    const engine: Engine = {
      hasSchema: true,
      define: () => ({ diagnostics: [] }),
      execute: () => ({ rows: [], diagnostics: [] }),
      query: () => {
        throw 'plain string';
      },
      close: () => undefined,
    };
    const failed = runProgram('match $x isa y;', () => engine).steps[0]!;
    expect(failed.error).toEqual({ message: 'plain string', line: 1 });
  });
});

describe('a big answer', () => {
  it('draws at most MAX_ROWS rows and counts the rest', () => {
    const engine: Engine = {
      hasSchema: true,
      define: () => ({ diagnostics: [] }),
      execute: () => ({ rows: [], diagnostics: [] }),
      query: () => ({ rows: Array.from({ length: MAX_ROWS + 250 }, (_, i) => ({ n: { toString: () => String(i) } })), diagnostics: [] }),
      close: () => undefined,
    };
    const step = runProgram('match $x isa y;', () => engine).steps[0]!;
    expect(step.rows).toHaveLength(MAX_ROWS);
    expect(step.omitted).toBe(250);
  });
});
