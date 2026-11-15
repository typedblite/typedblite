import { AstUtils, GrammarAST, GrammarUtils, stream, type Grammar } from 'langium';

/**
 * The TypeQLite TextMate grammar: what an editor colours before, and underneath, the semantic tokens.
 *
 * 🔴 **The keywords come from the Langium grammar; only their scopes are written here.** Langium's
 * own generator gives every keyword one scope, `keyword.control`, so a theme draws `define`,
 * `entity`, `string` and `@key` alike. TypeDB's TypeQL extension scopes them by what they are, and
 * themes colour them apart. This uses the same scopes, so that any theme colours TypeQLite as it
 * colours TypeQL (ADR-008 D8, row 3, amended 2026-11-13).
 *
 * A keyword the grammar gains is refused until it has a scope here, and a keyword the grammar loses
 * is refused until it leaves. So the grammar and its colouring cannot drift apart. Annotations are
 * scoped by their shape (`@` first), so a new one needs no entry.
 */
export const KEYWORD_SCOPES: Readonly<Record<string, readonly string[]>> = {
  // Statements, pipeline stages, constraints and clauses.
  'keyword.control': [
    'as', 'asc', 'check', 'define', 'delete', 'desc', 'distinct', 'end', 'fetch', 'first', 'from',
    'fun', 'given', 'groupby', 'has', 'iid', 'in', 'insert', 'isa', 'isa!', 'label', 'last', 'let',
    'limit', 'links', 'match', 'of', 'offset', 'owns', 'plays', 'put', 'redefine', 'reduce',
    'relates', 'require', 'return', 'select', 'sort', 'sub', 'sub!', 'undefine', 'update', 'value',
    'with',
  ],
  // The kinds of type a schema defines.
  'storage.type': ['attribute', 'entity', 'relation', 'struct'],
  // Value types.
  'storage.modifier': [
    'boolean', 'date', 'datetime', 'datetime-tz', 'decimal', 'double', 'duration', 'integer', 'long',
    'string',
  ],
  'keyword.operator.words': ['contains', 'is', 'like', 'not', 'or', 'try'],
  'constant.language': ['false', 'true'],
  'keyword.operator': ['!=', '%', '*', '+', '-', '->', '..', '/', '<', '<=', '=', '==', '>', '>=', '?', '^'],
  // Punctuation, which no scope colours.
  '': ['(', ')', ',', '.', ':', '::', ';', '[', ']', '{', '}'],
};

const ANNOTATION_SCOPE = 'keyword.annotations';

/** The file the grammar is written to, beside `langium-config.json`. */
export const TEXTMATE_OUT = 'syntaxes/typeqlite.tmLanguage.json';

export interface TextMateGrammar {
  readonly name: string;
  readonly scopeName: string;
  readonly fileTypes: readonly string[];
  readonly patterns: readonly object[];
  readonly repository: Readonly<Record<string, object>>;
}

/**
 * The keywords of a Langium grammar, collected as `langium-cli`'s own TextMate generator collects
 * them: every keyword in a reachable parser or infix rule. (`collectKeywords` is not exported from
 * `langium-cli`, so this restates it.)
 */
export function grammarKeywords(grammar: Grammar): string[] {
  const keywords = new Set<string>();
  const rules = stream(GrammarUtils.getAllReachableRules(grammar, false)).filter(
    (rule) => GrammarAST.isParserRule(rule) || GrammarAST.isInfixRule(rule),
  );
  for (const keyword of rules.flatMap((rule) => AstUtils.streamAllContents(rule).filter(GrammarAST.isKeyword))) {
    keywords.add(keyword.value);
  }
  return [...keywords].sort();
}

/**
 * The grammar for these keywords. Throws, naming them, when a keyword has no scope in
 * {@link KEYWORD_SCOPES} or the table names one the keywords lack.
 *
 * 🔴 **A name's characters bound every word match, not `\b`.** `-` is part of a TypeQLite name
 * (`project-id`, `$start-date`), so `\b` would colour the `value` in a label `value-type` and the `-`
 * in `project-id` as an operator. Each word match is fenced by lookarounds on `[\w-]`, and on `$`, `@`
 * and `.` before it, so a variable or a `$p.value` path is never read as a keyword. The regexes have
 * to run in both Oniguruma (VS Code) and JavaScript (the preview's tokenizer), so they keep to
 * syntax both share.
 */
export function typeqliteTextMate(keywords: readonly string[], fileTypes: readonly string[]): TextMateGrammar {
  const scoped = new Map<string, string>();
  for (const [scope, words] of Object.entries(KEYWORD_SCOPES)) for (const word of words) scoped.set(word, scope);
  const unscoped = keywords.filter((keyword) => !keyword.startsWith('@') && !scoped.has(keyword));
  if (unscoped.length > 0) {
    throw new Error(
      `No TextMate scope for the keyword(s) ${unscoped.join(' ')}. Give each one in KEYWORD_SCOPES, in typeqlite-textmate.ts.`,
    );
  }
  const present = new Set(keywords);
  const stale = [...scoped.keys()].filter((keyword) => !present.has(keyword));
  if (stale.length > 0) {
    throw new Error(`KEYWORD_SCOPES names ${stale.join(' ')}, which the grammar no longer has. Remove them.`);
  }

  const byScope = (scope: string) => keywords.filter((keyword) => scoped.get(keyword) === scope);
  const words = (scope: string) => ({
    name: `${scope}.typeqlite`,
    match: `(?<![\\w$@.-])(?:${alternation(byScope(scope))})(?![\\w-])`,
  });
  const annotations = keywords.filter((keyword) => keyword.startsWith('@')).map((keyword) => keyword.slice(1));
  // `-` and `->` start like a name's hyphen, so they count as operators only after a non-name.
  const operators = byScope('keyword.operator');

  return {
    name: 'typeqlite',
    scopeName: 'source.typeqlite',
    fileTypes,
    patterns: [
      { include: '#comments' },
      { include: '#strings' },
      { include: '#variables' },
      { include: '#annotations' },
      { include: '#keywords' },
      { include: '#numbers' },
      { include: '#operators' },
    ],
    repository: {
      comments: { patterns: [{ name: 'comment.line.number-sign.typeqlite', match: '#.*' }] },
      strings: {
        patterns: (['double', 'single'] as const).map((kind) => {
          const quote = kind === 'double' ? '"' : "'";
          return {
            name: `string.quoted.${kind}.typeqlite`,
            begin: quote,
            end: quote,
            patterns: [{ name: 'constant.character.escape.typeqlite', match: '\\\\.' }],
          };
        }),
      },
      variables: { patterns: [{ name: 'variable.parameter.typeqlite', match: '\\$[\\w-]+' }] },
      annotations: {
        patterns: [{ name: `${ANNOTATION_SCOPE}.typeqlite`, match: `(?<![\\w-])@(?:${alternation(annotations)})(?![\\w-])` }],
      },
      keywords: {
        patterns: ['keyword.control', 'storage.type', 'storage.modifier', 'keyword.operator.words', 'constant.language'].map(words),
      },
      numbers: {
        patterns: [{ name: 'constant.numeric.typeqlite', match: '(?<![\\w$-])[0-9]+(?:\\.[0-9]+)?(?![\\w-])' }],
      },
      operators: {
        patterns: [{ name: 'keyword.operator.typeqlite', match: `(?<![\\w-])(?:${alternation(operators.filter((op) => op.startsWith('-')))})|${alternation(operators.filter((op) => !op.startsWith('-')))}` }],
      },
    },
  };
}

/**
 * An alternation that tries a longer keyword before its prefix: `isa!` before `isa`.
 *
 * 🔴 `-` is not escaped. Outside a character class it is literal already, and JavaScript's `u` flag,
 * which the preview's tokenizer uses, refuses `\-` there.
 */
function alternation(keywords: readonly string[]): string {
  return [...keywords]
    .sort((a, b) => b.length - a.length || a.localeCompare(b))
    .map((keyword) => keyword.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
    .join('|');
}
