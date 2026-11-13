/**
 * Resolving a token's style from a VS Code colour theme, the way the editor does (ADR-010).
 *
 * 🔴 **VS Code has no API for this.** An extension can read the theme's kind (dark, light, high
 * contrast) and its workbench colours, never its token colours. So the client reads the theme's
 * files itself (`theme-loader.ts`) and this module applies the editor's rules to them. Each rule
 * below restates one of VS Code's, and the tests pin them:
 *
 * - **Semantic tokens** (`semanticTokenColors`): a selector `type.modifier:language` or
 *   `*.modifier` matches when its type, every modifier and its language match. A type scores 100,
 *   each modifier 100, a language 10. Each style field comes from the best-scoring rule that sets
 *   it, and a later rule wins a tie, so the user's customisations beat the theme.
 * - **Fallback**: a field no semantic rule sets comes from the token type's TextMate scopes, probed
 *   in VS Code's order (`type` → `entity.name.type`, then `support.type`). A token with no style at
 *   all is not drawn, and the TextMate colour underneath shows through.
 * - **TextMate** (`tokenColors`): a selector matches a scope when it is the scope or a dot-segment
 *   prefix of it (`string` matches `string.quoted.double`). A longer prefix beats a shorter one, a
 *   selector with matching ancestors (`source string`) beats one without, and a later rule wins a
 *   tie. A scope inherits every field its own match does not set from the scope that encloses it.
 *   `a - b` excludes.
 * - **Enabled**: `editor.semanticHighlighting.enabled` wins. When it is `configuredByTheme`, the
 *   customisation's `enabled` for this theme, then its global `enabled`, then the theme's
 *   `semanticHighlighting`, then off.
 */

export interface TokenStyle {
  readonly foreground?: string;
  readonly italic?: boolean;
  readonly bold?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
}

const FIELDS = ['foreground', 'italic', 'bold', 'underline', 'strikethrough'] as const;
type Field = (typeof FIELDS)[number];

/** One theme file's token colouring, with `include` and a `tokenColors` path already followed. */
export interface ThemeFile {
  readonly semanticHighlighting?: boolean;
  readonly semanticTokenColors?: Readonly<Record<string, unknown>>;
  readonly tokenColors?: readonly unknown[];
}

export interface ThemeSettings {
  /** The theme's id or label, for `[Theme Name]` blocks in the customisations. */
  readonly themeName: string;
  readonly semanticHighlighting: boolean | 'configuredByTheme';
  readonly semanticTokenColorCustomizations?: unknown;
  readonly tokenColorCustomizations?: unknown;
}

interface SemanticRule {
  readonly type: string;
  readonly modifiers: readonly string[];
  readonly language: string | undefined;
  readonly style: TokenStyle;
}

interface Selector {
  /** Ancestors then the scope itself: `source string` → `['source', 'string']`. */
  readonly path: readonly string[];
  readonly excluding: readonly (readonly string[])[];
}

interface TextMateRule {
  readonly selectors: readonly Selector[];
  readonly style: TokenStyle;
}

export interface Theme {
  readonly semanticHighlighting: boolean;
  readonly semantic: readonly SemanticRule[];
  readonly textmate: readonly TextMateRule[];
}

/** The theme files from the base `include` to the theme itself, and the user's settings. */
export function resolveTheme(files: readonly ThemeFile[], settings: ThemeSettings): Theme {
  const semanticColors: Record<string, unknown> = {};
  let themeSemantic: boolean | undefined;
  const textmate: TextMateRule[] = [];
  for (const file of files) {
    Object.assign(semanticColors, file.semanticTokenColors);
    if (typeof file.semanticHighlighting === 'boolean') themeSemantic = file.semanticHighlighting;
    textmate.push(...textMateRules(file.tokenColors));
  }
  const semantic = semanticRules(semanticColors);

  let customEnabled: boolean | undefined;
  for (const block of customisations(settings.semanticTokenColorCustomizations, settings.themeName)) {
    if (typeof block['enabled'] === 'boolean') customEnabled = block['enabled'];
    if (isObject(block['rules'])) semantic.push(...semanticRules(block['rules']));
  }
  for (const block of customisations(settings.tokenColorCustomizations, settings.themeName)) {
    for (const [group, scopes] of Object.entries(TOKEN_GROUPS)) {
      const style = styleOf(block[group]);
      if (style) textmate.push({ selectors: scopes.map(selector), style });
    }
    if (Array.isArray(block['textMateRules'])) textmate.push(...textMateRules(block['textMateRules']));
  }

  const semanticHighlighting =
    settings.semanticHighlighting === 'configuredByTheme'
      ? (customEnabled ?? themeSemantic ?? false)
      : settings.semanticHighlighting;
  return { semanticHighlighting, semantic, textmate };
}

/**
 * The style of a TextMate scope stack, outermost first (`['source.typeqlite', 'string.quoted…']`).
 * Undefined when nothing in the theme styles it.
 */
export function textMateStyle(theme: Theme, stack: readonly string[]): TokenStyle | undefined {
  const style: Partial<Record<Field, unknown>> = {};
  for (let depth = 0; depth < stack.length; depth += 1) {
    const matches: { score: readonly number[]; style: TokenStyle }[] = [];
    theme.textmate.forEach((rule, index) => {
      for (const candidate of rule.selectors) {
        const score = matchSelector(candidate, stack, depth);
        if (score) matches.push({ score: [...score, index], style: rule.style });
      }
    });
    matches.sort((a, b) => compareScores(a.score, b.score));
    for (const match of matches) assignDefined(style, match.style);
  }
  return nonEmpty(style);
}

/** The style of a semantic token, or undefined when the editor would leave the TextMate colour. */
export function semanticStyle(
  theme: Theme,
  type: string,
  modifiers: readonly string[],
  language = 'typeqlite',
): TokenStyle | undefined {
  if (!theme.semanticHighlighting) return undefined;
  const best: Partial<Record<Field, { score: number; value: unknown }>> = {};
  for (const rule of theme.semantic) {
    const score = scoreSemantic(rule, type, modifiers, language);
    if (score < 0) continue;
    for (const field of FIELDS) {
      const value = rule.style[field];
      if (value !== undefined && (best[field] === undefined || score >= best[field].score)) {
        best[field] = { score, value };
      }
    }
  }
  const style: Partial<Record<Field, unknown>> = {};
  for (const field of FIELDS) if (best[field]) style[field] = best[field].value;
  if (FIELDS.some((field) => style[field] === undefined)) {
    for (const probe of PROBES[type] ?? []) {
      const fallback = textMateStyle(theme, probe);
      if (!fallback) continue;
      for (const field of FIELDS) if (style[field] === undefined && fallback[field] !== undefined) style[field] = fallback[field];
      break;
    }
  }
  return nonEmpty(style);
}

/**
 * The TextMate scopes VS Code probes for a semantic token type that no semantic rule styles: its
 * `tokenClassificationRegistry`, read from VS Code 1.146's workbench.
 */
const PROBES: Readonly<Record<string, readonly (readonly string[])[]>> = {
  comment: [['comment']],
  string: [['string']],
  keyword: [['keyword.control']],
  number: [['constant.numeric']],
  regexp: [['constant.regexp']],
  operator: [['keyword.operator']],
  namespace: [['entity.name.namespace']],
  type: [['entity.name.type'], ['support.type']],
  struct: [['entity.name.type.struct']],
  class: [['entity.name.type.class'], ['support.class']],
  interface: [['entity.name.type.interface']],
  enum: [['entity.name.type.enum']],
  typeParameter: [['entity.name.type.parameter']],
  function: [['entity.name.function'], ['support.function']],
  method: [['entity.name.function.member'], ['support.function']],
  macro: [['entity.name.function.preprocessor']],
  variable: [['variable.other.readwrite'], ['entity.name.variable']],
  parameter: [['variable.parameter']],
  property: [['variable.other.property']],
  enumMember: [['variable.other.enummember']],
  event: [['variable.other.event']],
  decorator: [['entity.name.decorator'], ['entity.name.function']],
};

/** The scopes behind `editor.tokenColorCustomizations`' shorthand keys, as VS Code maps them. */
const TOKEN_GROUPS: Readonly<Record<string, readonly string[]>> = {
  comments: ['comment', 'punctuation.definition.comment'],
  strings: ['string', 'meta.embedded.assembly'],
  keywords: ['keyword - keyword.operator', 'keyword.control', 'storage', 'storage.type'],
  numbers: ['constant.numeric'],
  types: ['entity.name.type', 'entity.name.class', 'support.type', 'support.class'],
  functions: ['entity.name.function', 'support.function'],
  variables: ['variable', 'entity.name.variable'],
};

function scoreSemantic(rule: SemanticRule, type: string, modifiers: readonly string[], language: string): number {
  let score = 0;
  if (rule.type !== '*') {
    if (rule.type !== type) return -1;
    score += 100;
  }
  if (rule.language !== undefined) {
    if (rule.language !== language) return -1;
    score += 10;
  }
  for (const modifier of rule.modifiers) {
    if (!modifiers.includes(modifier)) return -1;
    score += 100;
  }
  return score;
}

function semanticRules(colors: Readonly<Record<string, unknown>>): SemanticRule[] {
  const rules: SemanticRule[] = [];
  for (const [key, value] of Object.entries(colors)) {
    const style = styleOf(value);
    const match = /^([\w*-]+)((?:\.[\w-]+)*)(?::([\w-]+))?$/.exec(key.trim());
    if (!style || !match) continue;
    rules.push({
      type: match[1]!,
      modifiers: match[2] ? match[2].slice(1).split('.') : [],
      language: match[3],
      style,
    });
  }
  return rules;
}

function textMateRules(rules: readonly unknown[] | undefined): TextMateRule[] {
  const parsed: TextMateRule[] = [];
  for (const rule of rules ?? []) {
    if (!isObject(rule) || !isObject(rule['settings'])) continue;
    const scope = rule['scope'];
    // A rule with no scope holds the theme's defaults (`editor.foreground`), not a token colour.
    const scopes = typeof scope === 'string' ? scope.split(',') : Array.isArray(scope) ? scope : [];
    const style = styleOf(rule['settings']);
    const selectors = scopes.filter((s): s is string => typeof s === 'string' && s.trim() !== '').map(selector);
    if (style && selectors.length > 0) parsed.push({ selectors, style });
  }
  return parsed;
}

function selector(text: string): Selector {
  const [include, ...exclude] = text.split(' - ');
  const path = (raw: string) => raw.trim().split(/\s+/).filter(Boolean);
  return { path: path(include!), excluding: exclude.map(path) };
}

const scopeMatches = (selected: string, scope: string) => scope === selected || scope.startsWith(`${selected}.`);

/** `[segments of the matched scope, ancestors matched]`, or undefined. */
function matchSelector(candidate: Selector, stack: readonly string[], depth: number): readonly number[] | undefined {
  const { path, excluding } = candidate;
  const target = path.at(-1);
  if (target === undefined || !scopeMatches(target, stack[depth]!)) return undefined;
  if (!ancestorsMatch(path.slice(0, -1), stack, depth)) return undefined;
  for (const excluded of excluding) {
    const last = excluded.at(-1);
    for (let d = 0; d <= depth && last !== undefined; d += 1) {
      if (scopeMatches(last, stack[d]!) && ancestorsMatch(excluded.slice(0, -1), stack, d)) return undefined;
    }
  }
  return [target.split('.').length, path.length - 1];
}

/** Do `ancestors` match scopes enclosing `depth`, in order, innermost last? */
function ancestorsMatch(ancestors: readonly string[], stack: readonly string[], depth: number): boolean {
  let d = depth - 1;
  for (let a = ancestors.length - 1; a >= 0; a -= 1) {
    while (d >= 0 && !scopeMatches(ancestors[a]!, stack[d]!)) d -= 1;
    if (d < 0) return false;
    d -= 1;
  }
  return true;
}

function compareScores(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** The customisation blocks that apply: the global one, then each `[Theme Name]` block naming this theme. */
function customisations(value: unknown, themeName: string): Record<string, unknown>[] {
  if (!isObject(value)) return [];
  const blocks: Record<string, unknown>[] = [value];
  for (const [key, block] of Object.entries(value)) {
    if (!key.startsWith('[') || !isObject(block)) continue;
    const names = [...key.matchAll(/\[([^\]]*)\]/g)].map((match) => match[1]!);
    if (names.some((name) => wildcard(name).test(themeName))) blocks.push(block);
  }
  return blocks;
}

const wildcard = (pattern: string) =>
  new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);

const COLOUR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** A rule's style: a colour string, or `{ foreground, fontStyle, bold, italic, … }`. */
function styleOf(value: unknown): TokenStyle | undefined {
  if (typeof value === 'string') return COLOUR.test(value) ? { foreground: value } : undefined;
  if (!isObject(value)) return undefined;
  const style: Partial<Record<Field, unknown>> = {};
  const foreground = value['foreground'];
  if (typeof foreground === 'string' && COLOUR.test(foreground)) style.foreground = foreground;
  const fontStyle = value['fontStyle'];
  if (typeof fontStyle === 'string') {
    // `fontStyle` sets all four: `""` is how a rule says "none of them", over an inherited italic.
    const words = fontStyle.split(/\s+/);
    for (const field of ['italic', 'bold', 'underline', 'strikethrough'] as const) style[field] = words.includes(field);
  }
  for (const field of ['italic', 'bold', 'underline', 'strikethrough'] as const) {
    if (typeof value[field] === 'boolean') style[field] = value[field];
  }
  return nonEmpty(style);
}

function assignDefined(target: Partial<Record<Field, unknown>>, source: TokenStyle): void {
  for (const field of FIELDS) if (source[field] !== undefined) target[field] = source[field];
}

function nonEmpty(style: Partial<Record<Field, unknown>>): TokenStyle | undefined {
  return FIELDS.some((field) => style[field] !== undefined) ? (style as TokenStyle) : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
