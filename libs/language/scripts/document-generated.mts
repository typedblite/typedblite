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

function documentAst(text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  const documented = (): boolean => /\*\/\s*$/.test(out[out.length - 1] ?? '');
  const add = (comment: string): void => {
    if (!documented()) out.push(`/** ${comment} */`);
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    let match: RegExpMatchArray | null;
    if ((match = line.match(/^export interface (\w+) extends langium\.AstNode \{/))) {
      add(`A \`${match[1]}\` node of the TypeQLite syntax tree: what the grammar rule \`${match[1]}\` produces. Its \`$type\` is \`'${match[1]}'\`.`);
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
              : `Whether \`item\` is a \`${match[2]}\` node, as a type guard. It is true for any subtype too.`,
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
const ast = readFileSync(astFile, 'utf8');
if (!ast.includes('export class TypeQLiteAstReflection')) throw new Error('document-generated: ast.ts is not the file Langium used to write');
const documentedAst = documentAst(ast);
writeFileSync(astFile, documentedAst);
for (const name of ['module.ts', 'grammar.ts']) {
  const file = generated(name);
  writeFileSync(file, documentFixed(readFileSync(file, 'utf8')));
}
const count = (documentedAst.match(/^\/\*\* /gm) ?? []).length;
console.log(`Documented ${count} generated declarations in ast.ts, and those in module.ts and grammar.ts`);
