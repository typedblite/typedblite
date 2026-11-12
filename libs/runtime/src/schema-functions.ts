import type { Range } from 'vscode-languageserver';
import { DiagnosticCode } from './diagnostics.js';
import type { Value } from './expressions.js';
import type { Refuse, SchemaFacts } from './schema-rules.js';
import { funSubject, ownsKey, ownsSubject, playsSubject, relatesSubject, structFieldSubject, structSubject, subSubject, typeSubject } from './schema-subjects.js';

/**
 * The schema functions — `get_doc(person)`, `get_meta("key", person)`, `get_all_meta(person)`,
 * their `get_<owns|plays|relates|sub>_…` forms over a capability, and `label($t)`.
 *
 * They differ from the arithmetic built-ins in two ways, and both are why they live here:
 *
 * - **Their arguments are types**, written as a label (`person`, `marriage:spouse`) or a type
 *   variable — not values. A type variable reaching a math built-in is still refused as an operand.
 * - **They answer a set of tuples, not one value.** `get_owns_doc(person, id)` answers NO row when
 *   `person` does not own `id` (metadata.feature L854), and `get_all_meta` answers a `(key, value)`
 *   row per `@meta`, read through `let $k, $v in …`. An annotation that is merely absent on a
 *   capability that exists is the empty string (L266, L550).
 *
 * They read `schema_annotation` through `SchemaFacts.annotations`, which `define` already writes —
 * no storage of their own. ⚠️ `get_fun_…` and `get_struct_…` need schema functions and structs,
 * which TypeDBLite does not store, so they are refused by name as not implemented — never as
 * "unknown", which would pass `get_fun_doc fails if the function does not exist` (L833) for the
 * wrong reason.
 */

export type SchemaArgument = { readonly kind: 'type'; readonly label: string } | { readonly kind: 'value'; readonly value: Value };

type Capability = 'owns' | 'plays' | 'relates' | 'sub';
type Reading = 'doc' | 'meta' | 'all_meta';

const METADATA = /^get_(?:(owns|plays|relates|sub|fun|struct_field|struct)_)?(all_meta|doc|meta)$/;

interface Signature {
  readonly capability?: Capability | 'fun' | 'struct_field' | 'struct';
  readonly reading: Reading;
}

const signatureOf = (bare: string): Signature | undefined => {
  const match = METADATA.exec(bare);
  if (!match) return undefined;
  return { capability: match[1] as Signature['capability'], reading: match[2] as Reading };
};

/** A schema function, by its bare name — what `expressions.ts` routes here instead of `builtin`. */
export const isSchemaFunction = (bare: string): boolean => bare === 'label' || signatureOf(bare) !== undefined;

/** How many variables one answer binds: two for `…all_meta` (`$key, $value`), else one. */
export const schemaFunctionWidth = (bare: string): number => (signatureOf(bare)?.reading === 'all_meta' ? 2 : 1);

/** How many arguments it takes — a type per side of the capability, and the key for `…meta`. */
const arityOf = (bare: string): number => {
  if (bare === 'label') return 1;
  const signature = signatureOf(bare);
  if (signature === undefined) return 0;
  // A function or a struct is ONE name; a struct field, a struct and a field; a capability, two types.
  const types = signature.capability === undefined || signature.capability === 'fun' || signature.capability === 'struct' ? 1 : 2;
  return types + (signature.reading === 'meta' ? 1 : 0);
};

const string = (text: string): Value => ({ valueType: 'string', text });

/** What an argument is, from its shape alone — a label, a variable (a type or a value), or a value. */
export type ArgumentShape = { readonly kind: 'label'; readonly label: string } | { readonly kind: 'variable' } | { readonly kind: 'value'; readonly valueType: string | undefined; readonly text?: string };

/**
 * Everything a schema call can be refused for WITHOUT a row — the arity, a value where a type
 * belongs, a type where the key belongs, a label the schema does not have — so an empty match
 * refuses it as a populated one does (`invariants.test.ts`: a refusal never depends on the data).
 * What a variable is bound to is only known per row, and `callSchemaFunction` checks that.
 */
export function checkSchemaCall(name: string, args: readonly ArgumentShape[], facts: SchemaFacts | undefined, refuse: Refuse, at: Range | undefined): void {
  const separator = name.lastIndexOf('::');
  const bare = separator < 0 ? name : name.slice(separator + 2);
  const signature = signatureOf(bare);
  const arity = arityOf(bare);
  if (args.length !== arity) {
    refuse(DiagnosticCode.functionArity, `Function '${bare}' expects '${arity}' arguments but received '${args.length}'.`, at);
  }
  // A function or a struct is named by a STRING — `get_fun_doc("get_random_number")` — not a label.
  if (signature?.capability === 'fun' || signature?.capability === 'struct' || signature?.capability === 'struct_field') {
    for (const argument of args) {
      if (argument.kind === 'label' || (argument.kind === 'value' && argument.valueType !== undefined && argument.valueType !== 'string')) {
        refuse(DiagnosticCode.valueTypeConflict, `Function '${bare}' names a ${signature.capability === 'fun' ? 'function' : 'struct'} by a string.`, at);
      }
    }
    // A name written in the query is checked now, whether or not a row reaches it (L833).
    const named = signature.reading === 'meta' ? args[1] : args[0];
    if (facts !== undefined && named?.kind === 'value' && named.text !== undefined) {
      if (signature.capability === 'fun' && !facts.functions.has(named.text)) refuse(DiagnosticCode.unknownFunction, `Function '${named.text}' not found.`, at);
      if (signature.capability !== 'fun' && !facts.structs.has(named.text)) refuse(DiagnosticCode.unknownType, `Struct '${named.text}' not found.`, at);
    }
    return;
  }
  const keyed = signature?.reading === 'meta';
  args.forEach((argument, i) => {
    if (keyed && i === 0) {
      if (argument.kind === 'label' || (argument.kind === 'value' && argument.valueType !== undefined && argument.valueType !== 'string')) {
        refuse(DiagnosticCode.valueTypeConflict, `Function '${bare}' expects a string key as its first argument.`, at);
      }
      return;
    }
    if (argument.kind === 'value') {
      refuse(DiagnosticCode.valueTypeConflict, `Function '${bare}' expects a type, and was given a value.`, at);
    }
    if (argument.kind === 'label' && facts !== undefined && !isKnown(argument.label, facts)) {
      refuse(DiagnosticCode.unknownType, `Type label '${argument.label}' not found.`, at);
    }
  });
}

/**
 * The strings an annotation was written with, unescaped — `@doc("a \"b\"")` is `a "b"`,
 * `@meta("key", "value")` is `key`, `value`. The record keeps the annotation as written
 * (`recordText`), so its strings are read back from that text.
 */
const stringsOf = (text: string): string[] =>
  [...text.matchAll(/"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'/g)].map((m) =>
    (m[1] ?? m[2] ?? '').replace(/\\(.)/g, (_, c: string) => ({ n: '\n', t: '\t', r: '\r' })[c] ?? c),
  );

const isRole = (label: string, facts: SchemaFacts): boolean => {
  const separator = label.indexOf(':');
  if (separator < 0) return false;
  return facts.roles.get(label.slice(0, separator))?.has(label.slice(separator + 1)) === true;
};

const isKnown = (label: string, facts: SchemaFacts): boolean =>
  facts.types.has(label) || facts.attributes.has(label) || isRole(label, facts);

/**
 * The record subject a function reads, or `undefined` when the capability it names does not exist —
 * which answers no row, not an error (metadata.feature L854–1043: undefined, and argument kinds that
 * do not fit the capability, both answer nothing).
 */
const subjectOf = (capability: Capability | undefined, types: readonly string[], facts: SchemaFacts): string | undefined => {
  const [left, right] = types;
  if (capability === undefined) {
    if (isRole(left, facts)) {
      const separator = left.indexOf(':');
      return relatesSubject(left.slice(0, separator), left.slice(separator + 1));
    }
    return typeSubject(left);
  }
  switch (capability) {
    case 'owns':
      return facts.owns.has(ownsKey(left, right)) ? ownsSubject(left, right) : undefined;
    case 'plays':
      return facts.plays.has(playsSubject(left, right)) ? playsSubject(left, right) : undefined;
    case 'relates': {
      // The role is written through its relation — `get_relates_doc(person, person:newrole)` — and
      // it is `left`'s own declared role or nothing.
      const separator = right.indexOf(':');
      if (separator < 0 || right.slice(0, separator) !== left) return undefined;
      return facts.roles.get(left)?.has(right.slice(separator + 1)) ? relatesSubject(left, right.slice(separator + 1)) : undefined;
    }
    case 'sub':
      return facts.parents.get(left) === right ? subSubject(left) : undefined;
  }
};

/**
 * `get_fun_doc("f")`, `get_struct_meta("key", "location")`, `get_struct_field_all_meta("location",
 * "latitude")` — metadata of a schema function, a struct or a struct field, each named by a string.
 * One that does not exist is refused (metadata.feature L833–L847); a missing annotation is `""`.
 */
function readNamedMetadata(
  bare: string,
  capability: 'fun' | 'struct' | 'struct_field',
  reading: Reading,
  args: readonly SchemaArgument[],
  facts: SchemaFacts,
  refuse: Refuse,
  at: Range | undefined,
): ReadonlyArray<ReadonlyArray<Value>> {
  const names = args.map((argument) => {
    if (argument.kind !== 'value' || argument.value.valueType !== 'string') {
      return refuse(DiagnosticCode.valueTypeConflict, `Function '${bare}' names a ${capability === 'fun' ? 'function' : 'struct'} by a string.`, at);
    }
    return argument.value.text;
  });
  const key = reading === 'meta' ? names[0] : undefined;
  const named: string[] = reading === 'meta' ? names.slice(1) : names;
  let subject: string;
  if (capability === 'fun') {
    if (!facts.functions.has(named[0])) return refuse(DiagnosticCode.unknownFunction, `Function '${named[0]}' not found.`, at);
    subject = funSubject(named[0]);
  } else {
    const fields = facts.structs.get(named[0]);
    if (fields === undefined) return refuse(DiagnosticCode.unknownType, `Struct '${named[0]}' not found.`, at);
    if (capability === 'struct_field' && !fields.has(named[1])) return refuse(DiagnosticCode.unknownType, `Struct '${named[0]}' has no field '${named[1]}'.`, at);
    subject = capability === 'struct' ? structSubject(named[0]) : structFieldSubject(named[0], named[1]);
  }
  const recorded = facts.annotations.get(subject);
  switch (reading) {
    case 'doc': {
      const text = recorded?.get('doc');
      return [[string(text === undefined ? '' : (stringsOf(text)[0] ?? ''))]];
    }
    case 'meta': {
      const text = recorded?.get(`meta:${key}`);
      return [[string(text === undefined ? '' : (stringsOf(text)[1] ?? ''))]];
    }
    case 'all_meta':
      return [...(recorded ?? new Map<string, string>())]
        .filter(([category]) => category.startsWith('meta:'))
        .map(([, text]) => {
          const [k = '', v = ''] = stringsOf(text);
          return [string(k), string(v)];
        });
  }
}

/**
 * Evaluate a schema function: every tuple it answers, each `schemaFunctionWidth` values wide.
 * Refuses an unknown label, a value where a type belongs (and the reverse), and the wrong arity.
 */
export function callSchemaFunction(
  name: string,
  args: readonly SchemaArgument[],
  facts: SchemaFacts,
  refuse: Refuse,
  at: Range | undefined,
): ReadonlyArray<ReadonlyArray<Value>> {
  const separator = name.lastIndexOf('::');
  const bare = separator < 0 ? name : name.slice(separator + 2);
  const signature = signatureOf(bare);
  const arity = arityOf(bare);
  if (args.length !== arity) {
    return refuse(DiagnosticCode.functionArity, `Function '${bare}' expects '${arity}' arguments but received '${args.length}'.`, at);
  }
  if (signature?.capability === 'fun' || signature?.capability === 'struct' || signature?.capability === 'struct_field') {
    return readNamedMetadata(bare, signature.capability, signature.reading, args, facts, refuse, at);
  }
  // `…meta` takes its key first, as a string value; the rest are types.
  const keyed = signature?.reading === 'meta';
  let key: string | undefined;
  if (keyed) {
    const first = args[0];
    if (first.kind !== 'value' || first.value.valueType !== 'string') {
      return refuse(DiagnosticCode.valueTypeConflict, `Function '${bare}' expects a string key as its first argument.`, at);
    }
    key = first.value.text;
  }
  const types = (keyed ? args.slice(1) : args).map((argument) => {
    if (argument.kind !== 'type') {
      return refuse(DiagnosticCode.valueTypeConflict, `Function '${bare}' expects a type, and was given a ${argument.value.valueType} value.`, at);
    }
    if (!isKnown(argument.label, facts)) {
      return refuse(DiagnosticCode.unknownType, `Type label '${argument.label}' not found.`, at);
    }
    return argument.label;
  });

  if (bare === 'label') return [[string(types[0])]];
  if (signature === undefined) return refuse(DiagnosticCode.unknownFunction, `Unknown function '${name}'.`, at);

  const subject = subjectOf(signature.capability as Capability | undefined, types, facts);
  if (subject === undefined) return [];
  const recorded = facts.annotations.get(subject);
  switch (signature.reading) {
    case 'doc': {
      const text = recorded?.get('doc');
      return [[string(text === undefined ? '' : (stringsOf(text)[0] ?? ''))]];
    }
    case 'meta': {
      const text = recorded?.get(`meta:${key}`);
      return [[string(text === undefined ? '' : (stringsOf(text)[1] ?? ''))]];
    }
    case 'all_meta':
      return [...(recorded ?? new Map<string, string>())]
        .filter(([category]) => category.startsWith('meta:'))
        .map(([, text]) => {
          const [k = '', v = ''] = stringsOf(text);
          return [string(k), string(v)];
        });
  }
}
