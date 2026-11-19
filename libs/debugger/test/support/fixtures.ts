import type { Files } from '../../src/program.js';

export const WORK = '/work';
export const SCHEMA = 'define attribute name, value string; attribute age, value integer; entity person, owns name, owns age;';
export const SEED = 'insert $c isa person, has name "Cid", has age 45;';
/** Three statements: two inserts, and a read with a comment inside it (lines are counted from 0 here). */
export const PROGRAM = [
  '# A small program',
  'insert $a isa person, has name "Ann", has age 30;',
  'insert $b isa person, has name "Bob", has age 17;',
  '',
  'match $p isa person, has name $n;',
  '  # only the names',
  'select $n;',
].join('\n');

/** The files a launch reads, by path. */
export function filesOf(entries: Record<string, string>): Files & { read: string[] } {
  const read: string[] = [];
  return {
    read,
    async readFile(path: string): Promise<string> {
      read.push(path);
      const text = entries[path];
      if (text === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
      return text;
    },
  };
}

export const standardFiles = (program = PROGRAM) =>
  filesOf({ [`${WORK}/schema.tql`]: SCHEMA, [`${WORK}/seed.tql`]: SEED, [`${WORK}/program.tql`]: program });
