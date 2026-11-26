import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Adds doc comments to what `langium generate` wrote, which has none, so that the API reference describes every
 * name it lists. Run after `langium generate` (the `langium-generate` target), because Langium rewrites these
 * files whole each time; they are git-ignored, so nothing here is committed.
 *
 * The descriptions say only what is true of the shape of the generated code, never what a rule means: a node
 * type is what the rule of that name produces, a guard tests for it, a union is its alternatives. What a rule
 * means is written beside it in `typeqlite.langium`, and the language guide.
 *
 * It fails when a file does not look as expected, so a change in Langium's output is noticed here and not as a
 * silent gap in the reference.
 */
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const generated = (name: string): string => resolve(root, 'src/generated', name);
// 🔴 `langium generate` writes the platform's line endings, and every pattern below is matched against a whole line. With
// the `\r` of CRLF left on, nothing matches and nothing says so: on Windows the reference lost every description.
const read = (path: string): string => readFileSync(path, 'utf8').replace(/\r\n/g, '\n');
const grammarLines = read(resolve(root, 'src/typeqlite.langium')).split('\n');

/** The text of the grammar that defines a node type: its rule, or its `{infer …}` alternative. `''` for a fragment's. */
function grammarFor(type: string): string {
  const rule = grammarLines.findIndex((line) => new RegExp(`^(?:entry\\s+)?${type}\\b[^:]*:|^\\w+\\s+infers\\s+${type}\\s*:`).test(line));
  if (rule >= 0) {
    const end = grammarLines.findIndex((line, i) => i > rule && (line.trim() === '' || /^[A-Za-z]/.test(line)));
    return grammarLines.slice(rule, end < 0 ? undefined : end).join('\n');
  }
  const alternative = grammarLines.findIndex((line) => line.includes(`{infer ${type}}`) || line.includes(`{${type}}`));
  if (alternative < 0) return '';
  const end = grammarLines.findIndex((line, i) => i > alternative && (/^\s*\|/.test(line) || line.trim() === '' || /^[A-Za-z]/.test(line)));
  return grammarLines.slice(alternative, end < 0 ? undefined : end).join('\n');
}

/** The keyword(s) a flag property is written as in a node type's grammar, if its definition is found. */
function flagTokens(type: string, property: string): string | undefined {
  const match = grammarFor(type).match(new RegExp(`\\b${property}\\?=((?:'[^']*'\\s*)+)`));
  return match?.[1]?.trim().split(/'\s*'/).map((token) => token.replace(/'/g, '')).join(' ').replace('[ ]', '[]');
}

/** Syntax examples the grammar's author wrote above a rule, one whole backticked line each: `// \`entity adr sub doc;\``. */
function examplesFor(type: string): string[] {
  const rule = grammarLines.findIndex((line) => new RegExp(`^(?:entry\\s+)?${type}\\b[^:]*:`).test(line));
  if (rule < 0) return [];
  const found: string[] = [];
  for (let i = rule - 1; i >= 0 && grammarLines[i]!.startsWith('//'); i--) {
    const example = grammarLines[i]!.match(/^\/\/\s*`([^`]+)`\s*(<-.*)?$/);
    if (example) found.unshift(example[1]!);
  }
  return found;
}

const FIXED: Record<string, string> = {
  TypeQLiteTerminals: "The regular expression of each of the grammar's terminal rules (variables, literals, names, whitespace and comments), by rule name.",
  TypeQLiteTerminalNames: "The names of the grammar's terminal rules.",
  TypeQLiteKeywordNames: 'Every keyword and punctuation token the grammar uses.',
  TypeQLiteTokenNames: "The name of every token of the grammar: its terminal rules and its keywords.",
  TypeQLiteAstType: 'Every node type of the syntax tree by name, which is the shape Langium types its services with.',
  TypeQLiteAstReflection: 'Tells Langium which node types the syntax tree has, what properties each has and which are subtypes of which. One instance is shared, as `reflection`.',
  reflection: 'The one `TypeQLiteAstReflection`, which the `is…` type guards ask.',
  TypeQLiteLanguageMetaData: "The language's id (`typeqlite`), its file extensions (`.typeqlite` and `.tql`) and its case sensitivity, as Langium takes them.",
  TypeQLiteGeneratedSharedModule: "The services Langium generates for the whole workspace rather than for one language: the AST reflection. `createTypeQLiteServices` composes it with the hand-written shared services.",
  TypeQLiteGeneratedModule: "The services Langium generates for TypeQLite: its grammar, its metadata and its parser. `createTypeQLiteServices` composes it with the hand-written services.",
  TypeQLiteGrammar: 'The TypeQLite grammar as a Langium `Grammar`, loaded from its JSON the first time it is asked for.',
};

/** `a` or `an`, for a node type's name. */
const a = (name: string): string => (/^[AEIOU]/.test(name) ? 'An' : 'A');

const code = (names: string[]): string => names.map((name) => `\`${name}\``).join(', ');

/** The text of a `type X = A | B` right-hand side, split into its alternatives. */
const alternatives = (declaration: string): string[] => declaration.replace(/^export type \w+ = /, '').replace(/;\s*$/, '').split(' | ').map((part) => part.trim());

function describeType(name: string, declaration: string): string {
  const parts = alternatives(declaration);
  if (parts.every((part) => /^'.*'$/.test(part))) {
    return parts.length <= 6
      ? `One of the keywords of the grammar rule \`${name}\`: ${code(parts.map((part) => part.slice(1, -1)))}.`
      : `One of the ${parts.length} keywords of the grammar rule \`${name}\`.`;
  }
  if (parts.every((part) => /^[A-Z]\w*$/.test(part))) {
    return parts.length <= 8
      ? `Any node the grammar rule \`${name}\` can produce: ${code(parts)}.`
      : `Any one of ${parts.length} node types the grammar rule \`${name}\` can produce: ${code(parts.slice(0, 4))} and others.`;
  }
  const literals = parts.filter((part) => /^'.*'$/.test(part));
  const others = parts.filter((part) => !/^'.*'$/.test(part));
  if (literals.length > 0 && others.every((part) => /^[A-Za-z]\w*$/.test(part))) {
    const keywords = literals.length <= 6 ? `${code(literals.map((part) => part.slice(1, -1)))}` : `one of ${literals.length} keywords`;
    return `A value of the grammar rule \`${name}\`: ${keywords}, or ${others.length === 1 && others[0] === 'string' ? 'a name' : `a ${others.map((part) => `\`${part}\``).join(' or ')}`}.`;
  }
  if (parts.length === 1 && /^(string|number|boolean|bigint)$/.test(parts[0]!)) {
    return `The value of the grammar rule \`${name}\`, which is a plain ${parts[0]}, not a node.`;
  }
  throw new Error(`document-generated: cannot describe \`${declaration.slice(0, 80)}\``);
}

/** What is true of a property from its type alone, which is all the generated code says. */
function describeProperty(type: string, name: string, declaration: string, optional: boolean, nodeTypes: ReadonlySet<string>): string {
  const refs = declaration.match(/langium\.Reference<(\w+)>/);
  const list = declaration.startsWith('Array<');
  const parts = declaration.replace(/^Array<(.*)>$/, '$1').split(' | ').map((part) => part.trim());
  const nodes = parts.filter((part) => nodeTypes.has(part));
  const values = parts.filter((part) => /^[A-Z]\w*$/.test(part) && !nodeTypes.has(part));
  const literals = parts.filter((part) => /^'.*'$/.test(part));
  const text = parts.includes('string');
  const absent = optional ? ' It is absent when the source does not write it.' : '';
  let sentence: string;
  if (name === 'subAnnotations') {
    sentence = 'The annotations written after the `sub` clause.';
  } else if (name === 'valueAnnotations') {
    sentence = 'The annotations written after the `value` clause.';
  } else if (refs) {
    sentence = `${list ? 'References' : 'A reference'} to ${list ? 'the' : 'a'} \`${refs[1]}\` the source names in \`${name}\`: \`.ref\` is the definition it resolves to (\`undefined\` if it does not), \`.$refText\` the name as written.`;
  } else if (declaration === 'boolean') {
    const tokens = flagTokens(type, name);
    sentence = tokens ? `\`true\` when the source writes \`${tokens}\`.` : `A flag: \`true\` when the source writes the option \`${name}\` stands for.`;
  } else if (declaration === 'number') {
    sentence = `The number written for \`${name}\`.`;
  } else if (list && nodes.length > 0 && values.length === 0) {
    sentence = `The ${code(nodes)} nodes written in \`${name}\`, in source order.`;
  } else if (list && values.length > 0 && nodes.length === 0) {
    sentence = `The ${code(values)} values written in \`${name}\`, in source order.`;
  } else if (list && text) {
    sentence = `The names written in \`${name}\`, in source order.`;
  } else if (literals.length > 0 && nodes.length === 0 && !text) {
    sentence = `One of ${code(literals.map((part) => part.slice(1, -1)))}, as written.`;
  } else if (nodes.length > 0 || values.length > 0) {
    const what = [...nodes.map((node) => `\`${node}\` node`), ...values.map((value) => `\`${value}\` value`)].join(' or ');
    sentence = `The ${what} written in \`${name}\`${text ? ', or the text written there' : ''}.`;
  } else if (text) {
    sentence = `The text written for \`${name}\`${literals.length > 0 ? `, or one of ${code(literals.map((part) => part.slice(1, -1)))}` : ''}.`;
  } else {
    throw new Error(`document-generated: cannot describe the property \`${name}: ${declaration}\``);
  }
  return sentence + absent;
}

/** The node types: every interface, and every union made only of node types. */
function nodeTypesOf(lines: string[]): Set<string> {
  const nodes = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^export interface (\w+) extends langium\.AstNode \{/);
    if (match) nodes.add(match[1]!);
  }
  const unions = lines.flatMap((line) => {
    const match = line.match(/^export type (\w+) = ([A-Z][\w ]*(?: \| [A-Z]\w*)*);$/);
    return match ? [{ name: match[1]!, parts: match[2]!.split(' | ').map((part) => part.trim()) }] : [];
  });
  for (let changed = true; changed; ) {
    changed = false;
    for (const union of unions) {
      if (!nodes.has(union.name) && union.parts.every((part) => nodes.has(part))) {
        nodes.add(union.name);
        changed = true;
      }
    }
  }
  return nodes;
}

function documentAst(text: string): string {
  const lines = text.split('\n');
  const nodeTypes = nodeTypesOf(lines);
  const out: string[] = [];
  const documented = (): boolean => /\*\/\s*$/.test(out[out.length - 1] ?? '');
  const add = (comment: string, indent = ''): void => {
    if (!documented()) out.push(`${indent}/** ${comment} */`);
  };
  /** A multi-line comment, for one with a code example. */
  const addBlock = (comment: string[]): void => {
    if (!documented()) out.push('/**', ...comment.map((line) => (` * ${line}`).trimEnd()), ' */');
  };
  let inside: string | undefined;
  let inAstType = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let match: RegExpMatchArray | null;
    if (line === 'export type TypeQLiteAstType = {') inAstType = true;
    else if (inAstType && line === '}') inAstType = false;
    else if (inAstType && (match = line.match(/^    (\w+): \w+$/))) add(`The \`${match[1]}\` node type.`, '    ');
    if (line === '    override readonly types = {') add('Every node type of the syntax tree, with its properties and its supertypes.', '    ');
    if (inside !== undefined) {
      if (line === '}') inside = undefined;
      else if ((match = line.match(/^    (?:readonly )?(\w+)(\??): (.+);$/)) && !match[1]!.startsWith('$')) {
        add(describeProperty(inside, match[1]!, match[3]!, match[2] === '?', nodeTypes), '    ');
      }
    }
    if ((match = line.match(/^export interface (\w+) extends langium\.AstNode \{/))) {
      const type = match[1]!;
      const examples = examplesFor(type);
      const summary = `${a(type)} \`${type}\` node of the TypeQLite syntax tree: what the grammar rule \`${type}\` produces. Its \`$type\` is \`'${type}'\`.`;
      if (examples.length > 0) addBlock([summary, '', 'Written like:', '', '```typeql', ...examples, '```']);
      else add(summary);
      inside = type;
    } else if ((match = line.match(/^export const (\w+) = \{$/)) && lines[i + 1]?.trim().startsWith('$type:')) {
      add(`The \`$type\` name of \`${match[1]}\` nodes: \`${match[1]}.$type\` is \`'${match[1]}'\`, the name \`reflection.isInstance\` and a \`switch\` on \`node.$type\` use.`);
    } else if ((match = line.match(/^export function is(\w+)\(item: unknown\): item is (\w+) \{/))) {
      const body = lines[i + 1] ?? '';
      const text = body.includes("typeof item === 'string'");
      const keyword = /(?<!typeof )item === '/.test(body);
      const rule = match[2]!;
      add(
        text && keyword
          ? `Whether \`item\` is a value of the grammar rule \`${rule}\`: one of its keywords, or other text. A type guard.`
          : text
            ? `Whether \`item\` is a value of the grammar rule \`${rule}\`, which is plain text. A type guard.`
            : keyword
              ? `Whether \`item\` is one of the keywords of the grammar rule \`${rule}\`, as a type guard.`
              : `Whether \`item\` is ${a(match[2]!).toLowerCase()} \`${match[2]}\` node, as a type guard. It is true for any subtype too.`,
      );
    } else if ((match = line.match(/^export type (\w+) = (.+)$/)) && !(match[1]! in FIXED)) {
      add(describeType(match[1]!, line));
    } else if ((match = line.match(/^export (?:const|class|type) (\w+)\b/)) && match[1]! in FIXED) {
      add(FIXED[match[1]!]!);
    }
    out.push(line);
  }
  return out.join('\n');
}

function documentFixed(text: string): string {
  return text
    .split('\n')
    .flatMap((line, i, all) => {
      const match = line.match(/^export const (\w+)\b/);
      const doc = match && FIXED[match[1]!];
      return doc && !/\*\/\s*$/.test(all[i - 1] ?? '') ? [`/** ${doc} */`, line] : [line];
    })
    .join('\n');
}

const astFile = generated('ast.ts');
const ast = read(astFile);
if (!ast.includes('export class TypeQLiteAstReflection')) throw new Error('document-generated: ast.ts is not the file Langium used to write');
const documentedAst = documentAst(ast);
writeFileSync(astFile, documentedAst);
for (const name of ['module.ts', 'grammar.ts']) {
  const file = generated(name);
  writeFileSync(file, documentFixed(read(file)));
}
const count = (documentedAst.match(/^\/\*\* /gm) ?? []).length;
console.log(`Documented ${count} generated declarations in ast.ts, and those in module.ts and grammar.ts`);
