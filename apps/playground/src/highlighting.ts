import { KEYWORD_SCOPES } from '@typedblite/language';

/**
 * How TypeQLite is colored in the playground's editor, before the language server answers and
 * underneath what it does: the keywords, strings, comments, variables and numbers a tokenizer can know
 * from text alone. The server adds the rest (a name resolved to a type, an attribute, a role) as semantic
 * tokens, as it does in VS Code.
 *
 * 🔴 **The keywords come from `KEYWORD_SCOPES`, the table the VS Code grammar is generated from**, never a
 * second list written here. A keyword the grammar gains fails that table's own check until it has a
 * scope, and so reaches this editor with it.
 */
export const LANGUAGE_ID = 'typeqlite';

const byScope = (scope: string): string[] => [...(KEYWORD_SCOPES[scope] ?? [])];

// Words and punctuation, split the way a tokenizer needs them.
const WORD = /^[A-Za-z]/;
const wordsOf = (scope: string): string[] => byScope(scope).filter((word) => WORD.test(word));
const symbolsOf = (scope: string): string[] => byScope(scope).filter((word) => !WORD.test(word));

/** The same scope names the TextMate grammar uses, so a theme written for one colors the other. */
export const TOKEN = {
  control: 'keyword.control.typeqlite',
  storage: 'storage.type.typeqlite',
  valueType: 'storage.modifier.typeqlite',
  operatorWord: 'keyword.operator.words.typeqlite',
  constant: 'constant.language.typeqlite',
  annotation: 'keyword.annotations.typeqlite',
  variable: 'variable.parameter.typeqlite',
  string: 'string.typeqlite',
  number: 'constant.numeric.typeqlite',
  comment: 'comment.typeqlite',
  operator: 'keyword.operator.typeqlite',
} as const;

const escape = (symbol: string): string => symbol.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The Monarch tokenizer. `-` is part of a name (`project-id`, `$start-date`), so a word is read whole and
 * only then looked up: the `value` inside `value-type` is a name, not a keyword.
 */
export const MONARCH = {
  defaultToken: '',
  controlWords: wordsOf('keyword.control'),
  storageWords: wordsOf('storage.type'),
  valueTypeWords: wordsOf('storage.modifier'),
  operatorWords: wordsOf('keyword.operator.words'),
  constantWords: wordsOf('constant.language'),
  tokenizer: {
    root: [
      [/#.*$/, TOKEN.comment],
      [/"/, { token: TOKEN.string, next: '@double' }],
      [/'/, { token: TOKEN.string, next: '@single' }],
      [/\$[\w-]+/, TOKEN.variable],
      [/@[A-Za-z][\w-]*/, TOKEN.annotation],
      // `isa!` and `sub!` are keywords with a `!`, which a name cannot hold.
      [/(?<![\w-])(?:isa|sub)!/, TOKEN.control],
      [
        /[A-Za-z_\u0080-￿][\w\-\u0080-￿]*/,
        {
          cases: {
            '@controlWords': TOKEN.control,
            '@storageWords': TOKEN.storage,
            '@valueTypeWords': TOKEN.valueType,
            '@operatorWords': TOKEN.operatorWord,
            '@constantWords': TOKEN.constant,
            '@default': 'identifier',
          },
        },
      ],
      [/(?<![\w$-])[0-9]+(?:\.[0-9]+)?(?![\w-])/, TOKEN.number],
      [new RegExp(`${[...symbolsOf('keyword.operator')].sort((a, b) => b.length - a.length).map(escape).join('|')}`), TOKEN.operator],
    ],
    double: [
      [/\\./, 'constant.character.escape.typeqlite'],
      [/[^\\"]+/, TOKEN.string],
      [/"/, { token: TOKEN.string, next: '@pop' }],
    ],
    single: [
      [/\\./, 'constant.character.escape.typeqlite'],
      [/[^\\']+/, TOKEN.string],
      [/'/, { token: TOKEN.string, next: '@pop' }],
    ],
  },
};

export interface ThemeRule {
  readonly token: string;
  readonly foreground: string;
  readonly fontStyle?: string;
}

/**
 * The colors VS Code's own Light Modern and Dark Modern give these scopes, so TypeQLite looks here as it
 * does in the editor. A rule's token is a prefix of the scope; a semantic token is matched by its type.
 */
const palette = {
  light: {
    control: 'AF00DB', storage: '0000FF', operatorWord: '0000FF', constant: '0000FF', escape: '795E26',
    variable: '001080', string: 'A31515', number: '098658', comment: '008000', operator: '000000', type: '267F99',
  },
  dark: {
    control: 'C586C0', storage: '569CD6', operatorWord: '569CD6', constant: '569CD6', escape: 'DCDCAA',
    variable: '9CDCFE', string: 'CE9178', number: 'B5CEA8', comment: '6A9955', operator: 'D4D4D4', type: '4EC9B0',
  },
} as const;

export function themeRules(scheme: 'light' | 'dark'): ThemeRule[] {
  const c = palette[scheme];
  return [
    { token: 'keyword.control', foreground: c.control },
    { token: 'storage.type', foreground: c.storage },
    { token: 'storage.modifier', foreground: c.storage },
    { token: 'keyword.operator.words', foreground: c.operatorWord },
    { token: 'constant.language', foreground: c.constant },
    // An annotation is a keyword to VS Code's themes: the grammar scopes it `keyword.annotations.typeqlite`, and
    // Dark Modern and Light Modern color `keyword` as `storage`. The editor and the site show the same.
    { token: 'keyword.annotations', foreground: c.storage },
    { token: 'keyword.operator', foreground: c.operator },
    { token: 'variable.parameter', foreground: c.variable },
    { token: 'string', foreground: c.string },
    { token: 'constant.numeric', foreground: c.number },
    { token: 'constant.character.escape', foreground: c.escape },
    { token: 'comment', foreground: c.comment },
    // The language server's semantic tokens, by their LSP type.
    { token: 'type', foreground: c.type },
    { token: 'property', foreground: c.variable },
    { token: 'parameter', foreground: c.variable },
    { token: 'variable', foreground: c.variable },
    { token: 'number', foreground: c.number },
  ];
}

/** The editor's own surface colors, matched to the page's code background. */
export const SURFACE = {
  light: { 'editor.background': '#f7f5f1', 'editor.foreground': '#15171c' },
  dark: { 'editor.background': '#14161b', 'editor.foreground': '#f4f2ee' },
} as const;
