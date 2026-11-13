import type { ScopeToken } from '../markdown/protocol.js';

type Captures = Readonly<Record<string, { readonly name?: string }>>;

interface RawRule {
  readonly name?: string;
  readonly contentName?: string;
  readonly match?: string;
  readonly begin?: string;
  readonly end?: string;
  readonly patterns?: readonly RawRule[];
  readonly include?: string;
  readonly captures?: Captures;
  readonly beginCaptures?: Captures;
  readonly endCaptures?: Captures;
  readonly comment?: string;
}

export interface RawGrammar {
  readonly scopeName: string;
  readonly patterns: readonly RawRule[];
  readonly repository?: Readonly<Record<string, RawRule>>;
}

const RULE_KEYS = new Set([
  'name',
  'contentName',
  'match',
  'begin',
  'end',
  'patterns',
  'include',
  'captures',
  'beginCaptures',
  'endCaptures',
  'comment',
]);

interface MatchRule {
  readonly kind: 'match';
  readonly name: string | undefined;
  readonly regex: RegExp;
  readonly captures: Captures;
}

interface BeginEndRule {
  readonly kind: 'begin';
  readonly name: string | undefined;
  readonly contentName: string | undefined;
  readonly begin: RegExp;
  readonly end: RegExp;
  readonly beginCaptures: Captures;
  readonly endCaptures: Captures;
  readonly raw: readonly RawRule[];
}

type Rule = MatchRule | BeginEndRule;

interface Frame {
  readonly rule: BeginEndRule;
  /** The scopes of the begin and end matches. */
  readonly scopes: readonly string[];
  /** The scopes of the text between them: `scopes` plus the rule's `contentName`. */
  readonly content: readonly string[];
}

const NONE: readonly string[] = [];

/**
 * Tokenize text with a TextMate grammar, as VS Code's editor does before semantic tokens arrive.
 *
 * 🔴 **This is not a TextMate engine; it is enough of one for the grammar Langium generates.** That
 * grammar uses `match`, `begin`/`end`, `include` from its repository, and captures, and nothing else.
 * Any other construct (`while`, an external include, an `end` that back-references its `begin`) is
 * **refused, not skipped**. A construct skipped here would colour a code block differently from the
 * editor with no sign of why. The regexes run as JavaScript with the `u` flag, so the
 * Oniguruma-only syntax that the `u` flag rejects fails loudly too.
 *
 * Lines are scanned one at a time, as in TextMate, so `$` is the end of a line. At one position, an
 * open rule's `end` wins over its patterns, and an earlier pattern wins over a later one.
 */
export function tokenizeTextMate(grammar: RawGrammar, text: string): ScopeToken[] {
  const compiler = new Compiler(grammar);
  const top = compiler.list(grammar.patterns);
  const scopesAt: (readonly string[])[] = new Array<readonly string[]>(text.length).fill(NONE);
  const paint = (from: number, to: number, scopes: readonly string[]) => {
    for (let i = from; i < to; i += 1) scopesAt[i] = scopes;
  };
  const capture = (captures: Captures, match: RegExpExecArray, base: number, scopes: readonly string[]) => {
    for (const [group, { name }] of Object.entries(captures)) {
      const span = match.indices?.[Number(group)];
      if (name && span) paint(base + span[0], base + span[1], [...scopes, name]);
    }
  };

  const stack: Frame[] = [];
  let base = 0;
  for (const line of text.split('\n')) {
    let pos = 0;
    for (let steps = 0; pos <= line.length; steps += 1) {
      if (steps > line.length * 4 + 64) {
        throw new Error(`The TextMate grammar ${grammar.scopeName} does not advance on the line '${line}'.`);
      }
      const frame = stack.at(-1);
      const patterns = frame ? compiler.list(frame.rule.raw) : top;
      const scopes = frame ? frame.content : NONE;

      let best: { rule: Rule | 'end'; match: RegExpExecArray } | undefined;
      if (frame) {
        const match = exec(frame.rule.end, line, pos);
        if (match) best = { rule: 'end', match };
      }
      for (const rule of patterns) {
        const match = exec(rule.kind === 'match' ? rule.regex : rule.begin, line, pos);
        if (match && (!best || match.index < best.match.index)) best = { rule, match };
      }
      if (!best) {
        paint(base + pos, base + line.length, scopes);
        break;
      }

      const { rule, match } = best;
      const start = match.index;
      const end = start + match[0].length;
      paint(base + pos, base + start, scopes);
      if (rule === 'end') {
        paint(base + start, base + end, frame!.scopes);
        capture(frame!.rule.endCaptures, match, base, frame!.scopes);
        stack.pop();
      } else {
        const named = rule.name ? [...scopes, rule.name] : scopes;
        paint(base + start, base + end, named);
        if (rule.kind === 'match') {
          capture(rule.captures, match, base, named);
          // A zero-width match changes nothing, so the same position would match it forever.
          if (end === start) {
            paint(base + start, base + start + 1, scopes);
            pos = end + 1;
            continue;
          }
        } else {
          capture(rule.beginCaptures, match, base, named);
          stack.push({
            rule,
            scopes: named,
            content: rule.contentName ? [...named, rule.contentName] : named,
          });
        }
      }
      pos = end;
    }
    // The line break belongs to whatever is still open, so a string spanning lines stays one run.
    if (base + line.length < text.length) paint(base + line.length, base + line.length + 1, stack.at(-1)?.content ?? NONE);
    base += line.length + 1;
  }
  return runs(scopesAt);
}

function exec(regex: RegExp, line: string, from: number): RegExpExecArray | null {
  regex.lastIndex = from;
  return regex.exec(line);
}

function runs(scopesAt: readonly (readonly string[])[]): ScopeToken[] {
  const tokens: ScopeToken[] = [];
  let start = 0;
  const key = (scopes: readonly string[]) => scopes.join('\u0000');
  for (let i = 1; i <= scopesAt.length; i += 1) {
    if (i < scopesAt.length && key(scopesAt[i]!) === key(scopesAt[start]!)) continue;
    const scopes = scopesAt[start]!;
    if (scopes.length > 0) tokens.push({ offset: start, length: i - start, scopes });
    start = i;
  }
  return tokens;
}

class Compiler {
  private readonly compiled = new Map<RawRule, Rule>();
  private readonly lists = new Map<readonly RawRule[], Rule[]>();

  constructor(private readonly grammar: RawGrammar) {}

  /**
   * A pattern list with every include and every container of patterns flattened into it.
   *
   * `expanding` holds the containers being flattened on the way here. A container met again inside
   * itself adds no pattern it has not already added, so it is skipped rather than recursed into.
   */
  list(raws: readonly RawRule[] | undefined, expanding: ReadonlySet<RawRule> = new Set()): Rule[] {
    if (!raws) return [];
    const top = expanding.size === 0;
    const cached = top ? this.lists.get(raws) : undefined;
    if (cached) return cached;
    const rules: Rule[] = [];
    for (const raw of raws) {
      const target = raw.include !== undefined ? this.resolve(checked(raw).include!) : raw;
      checked(target);
      if (target.match !== undefined || target.begin !== undefined) {
        rules.push(this.rule(target));
      } else if (target.include !== undefined || target.patterns) {
        if (expanding.has(target)) continue;
        const inner = new Set([...expanding, target]);
        rules.push(...this.list(target.include !== undefined ? [target] : target.patterns, inner));
      } else {
        throw new Error(`A TextMate rule with no match, begin, include or patterns: ${JSON.stringify(raw)}.`);
      }
    }
    if (top) this.lists.set(raws, rules);
    return rules;
  }

  /** The whole grammar as one container: one object, so that including it again is seen as a cycle. */
  private self: RawRule | undefined;

  private resolve(include: string): RawRule {
    if (include === '$self' || include === '$base') return (this.self ??= { patterns: this.grammar.patterns });
    if (include.startsWith('#')) {
      const target = this.grammar.repository?.[include.slice(1)];
      if (!target) throw new Error(`The TextMate include '${include}' names nothing in the repository.`);
      return target;
    }
    throw new Error(`Unsupported TextMate include '${include}': only the grammar's own repository is.`);
  }

  private rule(raw: RawRule): Rule {
    const cached = this.compiled.get(raw);
    if (cached) return cached;
    let rule: Rule;
    if (raw.match !== undefined) {
      rule = { kind: 'match', name: raw.name, regex: regex(raw.match), captures: raw.captures ?? {} };
    } else {
      if (raw.end === undefined) throw new Error(`A TextMate begin rule with no end: ${raw.begin}.`);
      if (/\\\d/.test(raw.end)) throw new Error(`Unsupported TextMate end with a back-reference: ${raw.end}.`);
      rule = {
        kind: 'begin',
        name: raw.name,
        contentName: raw.contentName,
        begin: regex(raw.begin!),
        end: regex(raw.end),
        beginCaptures: { ...raw.captures, ...raw.beginCaptures },
        endCaptures: { ...raw.captures, ...raw.endCaptures },
        raw: raw.patterns ?? [],
      };
    }
    this.compiled.set(raw, rule);
    return rule;
  }
}

function checked(raw: RawRule): RawRule {
  const unknown = Object.keys(raw).filter((key) => !RULE_KEYS.has(key));
  if (unknown.length > 0) throw new Error(`Unsupported TextMate rule key(s): ${unknown.join(', ')}.`);
  return raw;
}

function regex(source: string): RegExp {
  try {
    return new RegExp(source, 'dgu');
  } catch (error) {
    throw new Error(`A TextMate regex JavaScript cannot run: ${source} (${(error as Error).message}).`);
  }
}
