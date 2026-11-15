grammar TypeQLite

import './terminals';

// TypeQLite 3.x — the subset actually used by the downstream application and downstream-store, and since 2026-09-11 what
// TypeDB's own behaviour specification needs to get past its Backgrounds.
//
// Scope was measured, not guessed (2026-08-29): every TypeQLite string in
// `downstream-app/libs/platform/{iam,skills}/infrastructure` and
// `downstream-monorepo/tools/downstream-store/schema`. What is here is what those use. What TypeDB has and
// this does not — rules/inference, aggregation, negation, `sort`/`limit`/`offset`, expressions,
// structs — is absent because no caller writes it, not because it was too hard. Adding a
// construct starts by finding a caller that needs it.
//
// 🔴 The caller is now also `typedb/typedb-behaviour` (ADR-005), vendored under
// `libs/core/typedblite/conformance/spec/`. Its `query/language/` Backgrounds are the acceptance
// test for this file — `test/spec-backgrounds.spec.ts` — and what they use decides what is here.
// Parsing a construct is one claim; enforcing what it means is the interpreter's, and the
// conformance report card measures that scenario by scenario.

entry TypeQLiteFile:
    clauses+=Clause*;

Clause:
    DefineClause | UndefineClause | RedefineClause | Pipeline;

// ── Schema ──────────────────────────────────────────────────────────────────

// `define` alone is valid, and defines nothing (define.feature L36).
DefineClause:
    {infer DefineClause} 'define' definitions+=Definition*;

// `fun` and `struct` are schema definitions too — a function the schema stores, callable from any
// query (expression.feature L1382), and a struct, whose metadata the schema functions read
// (metadata.feature L113).
Definition:
    EntityDef | RelationDef | AttributeDef | TypeExtensionDef | SchemaFunction | StructDef;

// `struct location @doc("…"): latitude value double @doc("…"), longitude value double;`
StructDef:
    'struct' name=ID annotations+=Annotation* ':' fields+=StructField (',' fields+=StructField)* ';';

StructField:
    name=ID 'value' valueType=ValueType (optional?='?')? annotations+=Annotation*;

// `entity skill, owns skill-id @key, plays skill-composition:owner;`
// `entity adr sub doc;`                     <- downstream-store's subtyping
// `entity person plays employment:employee, owns name @card(0..);`  <- the spec's form
// `entity abstract-type @abstract;`
//
// 🔴 The comma after the label is OPTIONAL. TypeDB 3.10.4 accepts `entity person, owns ref` and
// `entity person owns ref` alike (verified on the live server 2026-09-11); this grammar required
// the comma, and every Background in the behaviour spec is written without it —
// `d-20260911-the-typeql-grammar-requires-a-comma`. Between traits the comma stays required.
// The same holds before `sub`: `relation person, sub base @doc("…")` (metadata.feature L228), as
// `AttributeDef` already admitted.
//
// 🔴 **An annotation belongs to the thing it follows, and the AST says which.** `entity player
// @abstract sub person` annotates the *type*; `entity player sub person @abstract` annotates the
// *sub*, which TypeDB refuses — nothing but `@doc`/`@meta` may sit on a `sub`. One merged list
// could not tell the two apart, so the validator's admissibility table had nothing to read
// (Phase 03 of the conformance feature). `value` on an entity or relation parses because TypeQLite's
// type-constraint grammar is kind-agnostic and TypeDB refuses it at `define`, not at parse —
// `define.feature` L392 says `; fails`, not `parsing fails`.
// `sub` may come after the traits too — `relation best-friendship relates best-friend as friend, sub
// friendship;` (update.feature L2120, redefine.feature L418) — as TypeDB's grammar admits.
// Between traits the comma stays required (`optional-trait-comma.spec.ts`); before the first, and before a
// `sub` or `value` written ahead of the traits, it is optional.
EntityDef:
    'entity' name=ID annotations+=Annotation* (','? EntityHead)*
    (','? traits+=Trait (',' (traits+=Trait | EntityHead))*)? ';';

fragment EntityHead:
    'sub' superType=[EntityDef:ID] subAnnotations+=Annotation*
    | 'value' valueType=ValueType valueAnnotations+=Annotation*;

// `relation membership, relates member, relates org, owns membership-key @key;`
RelationDef:
    'relation' name=ID annotations+=Annotation* (','? RelationHead)*
    (','? traits+=Trait (',' (traits+=Trait | RelationHead))*)? ';';

fragment RelationHead:
    'sub' superType=[RelationDef:ID] subAnnotations+=Annotation*
    | 'value' valueType=ValueType valueAnnotations+=Annotation*;

// `attribute principal-id, value string;`
// `attribute age @independent, value integer;`          <- annotation on the type
// `attribute email value string @regex("^.*@.*$");`      <- annotation on the VALUE TYPE
// `attribute empty-sub-data @abstract, sub empty-data;`  <- annotation before `sub`
// `attribute person-name sub name;`                      <- attribute subtyping, no value type
// `sub` and `value` in either order: `attribute name value string, sub valueless-name;` (match.feature L4214).
AttributeDef:
    'attribute' name=ID annotations+=Annotation*
    (
          (','? 'sub' superType=[AttributeDef:ID] subAnnotations+=Annotation*) (','? 'value' valueType=ValueType valueAnnotations+=Annotation*)?
        | (','? 'value' valueType=ValueType valueAnnotations+=Annotation*) (','? 'sub' superType=[AttributeDef:ID] subAnnotations+=Annotation*)?
    )? ';';

// `principal plays membership:member;` — a re-open of an already-defined type, with no kind
// keyword. The spec re-opens with a whole trait list: `person plays employment:employee, owns
// name @card(0..), owns ref @key;` (`given.feature`), so this is EntityDef's tail on an existing
// name — and the generator and interpreter treat its traits exactly as they treat a definition's.
//
// A re-open may also say `sub` (`person sub parent;`, `name sub valueless-name;`) and `value`
// (`name value integer;`). The parent is a plain name here, not a cross-reference: the re-opened
// type's kind is not in the text, so which definition it could resolve to is the interpreter's to
// decide against the applied schema.
TypeExtensionDef:
    type=ID annotations+=Annotation*
    (','? 'sub' superType=ID subAnnotations+=Annotation*)?
    (','? 'value' valueType=ValueType valueAnnotations+=Annotation*)?
    (','? traits+=Trait (',' traits+=Trait)*)? ';';

// ── undefine ────────────────────────────────────────────────────────────────
//
// Phase 04 of the conformance feature (ADR-005). 🔴 `undefine` is NOT `define` with a different
// keyword: TypeDB's grammar admits only the targeted forms — a bare type name, and `<what> from
// <type> [<capability>]` — and the behaviour spec calls every define-like form a PARSING failure
// (`undefine entity person;`, `undefine person owns name;`, `undefine name value string;` —
// undefine.feature L42). So this rule has no kind keyword and no trait list, on purpose.
//
// `undefine` alone is a valid, empty statement.
UndefineClause:
    {infer UndefineClause} 'undefine' undefinitions+=Undefinition*;

Undefinition:
    UndefineFrom | UndefineType;

// `undefine person;` — the type itself, whatever its kind.
UndefineType:
    type=ID ';';

// `sub person from child;` `owns name from person;` `plays employment:employee from person;`
// `relates employee from employment;` `value string from name;` `@card from person owns name;`
// `@regex from email value string;` `as parent from fathership relates father;`
UndefineFrom:
    target=UndefineTarget 'from' type=ID (capability=Capability)? ';';

UndefineTarget:
      {infer UndefineAnnotation} category=AnnotationKeyword ('(' key=STRING ')')?
    | {infer UndefineSub} 'sub' superType=ID
    | {infer UndefineOwns} 'owns' attribute=ID (ordered?='[' ']')?
    | {infer UndefinePlays} 'plays' role=RoleName
    | {infer UndefineRelates} 'relates' role=ID (ordered?='[' ']')?
    | {infer UndefineValue} 'value' valueType=ValueType
    | {infer UndefineSpecialise} 'as' role=ID;

// The capability an annotation or a specialisation is removed from: `… from person owns name`.
Capability:
      {infer CapabilityOwns} 'owns' attribute=ID (ordered?='[' ']')?
    | {infer CapabilityPlays} 'plays' role=RoleName
    | {infer CapabilityRelates} 'relates' role=ID (ordered?='[' ']')?
    | {infer CapabilitySub} 'sub' superType=ID
    | {infer CapabilityValue} 'value' valueType=ValueType;

// An annotation named by its category alone — `@card`, not `@card(1..1)`.
AnnotationKeyword returns string:
    '@key' | '@unique' | '@card' | '@independent' | '@abstract' | '@distinct' | '@cascade'
    | '@regex' | '@values' | '@range' | '@doc' | '@meta';

// `employment:employee` as plain names — undefine and redefine name things defined elsewhere,
// and a cross-reference would resolve to nothing in this document.
RoleName:
    relation=ID ':' role=ID;

// ── redefine ────────────────────────────────────────────────────────────────
//
// 🔴 Stricter than `define`, on purpose. TypeDB's `redefine` takes exactly ONE statement making
// exactly ONE change, and the spec calls the rest PARSING failures: `redefine entity person;`
// (nothing to change), two traits in one statement, a variable (`redefine $p isa person;`).
// Whether the one change IS a change — "Nothing was redefined" — is the interpreter's.
RedefineClause:
    {infer RedefineClause} 'redefine' (redefinition=Redefinition)?;

Redefinition:
    RedefineRoleLabel | RedefineType;

// `redefine entity person owns name @card(0..1);` `redefine child sub person;`
// `redefine attribute email value integer;` `redefine entity before-rename label after-rename;`
// `redefine player @abstract;`
RedefineType:
    (kind=Kind)? type=ID change=RedefineChange ';';

Kind returns string:
    'entity' | 'relation' | 'attribute';

RedefineChange:
      {infer RedefineLabel} 'label' newLabel=ID
    | {infer RedefineSub} 'sub' superType=ID
    | {infer RedefineValue} 'value' valueType=ValueType annotations+=Annotation*
    | {infer RedefineTrait} trait=Trait
    | {infer RedefineAnnotations} annotations+=Annotation+;

// `redefine relation-of-rename:before-rename label sibling-role;` — a role is renamed through its relation.
RedefineRoleLabel:
    role=RoleName 'label' newLabel=ID ';';

Trait:
    OwnsTrait | RelatesTrait | PlaysTrait;

// 🔴 These are real Langium cross-references, not strings. Langium then resolves them, and an
// unresolved name becomes an error for free — along with go-to-definition and find-references in
// any editor. A grammar that merely parses `owns nonexistent-attribute` is not checking anything.
// `owns name[]` — an ORDERED ownership, a list (define.feature L338). A different definition from
// `owns name`, not a variant of it: one type cannot have both.
OwnsTrait:
    'owns' attribute=[AttributeDef:ID] (ordered?='[' ']')? annotations+=Annotation*;

// `name`, not `role`, so the role is a *named element* other references can resolve to.
// `relates parent[]` — an ordered role, as `owns name[]` is an ordered ownership.
// `relates father as parent` — a role SPECIALISING an inherited one: `fathership:father` is a sub-role
// of `parentship:parent` (define.feature L635).
RelatesTrait:
    'relates' name=ID (ordered?='[' ']')? ('as' specialises=ID)? annotations+=Annotation*;

// `plays employment:employee @card(0..)` — the spec annotates plays as it does owns.
PlaysTrait:
    'plays' role=RoleRef annotations+=Annotation*;

// The role is scoped to the relation named alongside it, not looked up globally — see
// `TypeQLiteScopeProvider`. Two relations may each relate a role called `member`.
RoleRef:
    relation=[RelationDef:ID] ':' role=[RelatesTrait:ID];

// ⚠️ Every annotation here PARSES. Only `@key` is enforced by the runtime; the rest are accepted
// and reported by `define` as *parsed and not enforced* — founder decision 2026-09-11, the third
// outcome between refusing a valid schema and silently ignoring a constraint. The conformance
// report card measures each one's semantics as they land.
Annotation:
    KeyAnnotation | UniqueAnnotation | CardAnnotation | IndependentAnnotation | AbstractAnnotation
    | DistinctAnnotation | CascadeAnnotation | RegexAnnotation | ValuesAnnotation | RangeAnnotation
    | DocAnnotation | MetaAnnotation;

// The whole point of both schemas — see the header comments in iam.schema.typeqlite and
// skills.schema.typeqlite. Generates a UNIQUE index.
KeyAnnotation:
    {infer KeyAnnotation} '@key';

UniqueAnnotation:
    {infer UniqueAnnotation} '@unique';

// `@card(0..)` — downstream-store's multi-valued attributes. An absent upper bound is unbounded.
// `@card(2)` is exactly two (update.feature L727).
CardAnnotation:
    '@card' '(' min=INT (range?='..' (max=INT)?)? ')';

// `attribute age @independent, value integer;` — an attribute instance may exist with no owner.
IndependentAnnotation:
    {infer IndependentAnnotation} '@independent';

// `entity abstract-type @abstract;` — no instances of this type itself, only of its subtypes.
AbstractAnnotation:
    {infer AbstractAnnotation} '@abstract';

DistinctAnnotation:
    {infer DistinctAnnotation} '@distinct';

CascadeAnnotation:
    {infer CascadeAnnotation} '@cascade';

// `value string @regex("^.*@.*$")`
RegexAnnotation:
    '@regex' '(' pattern=STRING ')';

// `value integer @values(1, 2, 3)`
ValuesAnnotation:
    '@values' '(' values+=Literal (',' values+=Literal)* ')';

// `value string @range("A".."z")` — either bound may be absent.
RangeAnnotation:
    '@range' '(' (min=Literal)? '..' (max=Literal)? ')';

// `entity player @doc("docs here")`, `@meta("key", "value")` — metadata TypeDB stores and
// `get_doc()` reads back. Parsed since Phase 03 of the conformance feature because the
// admissibility table has rows for them; retained nowhere yet, and reported as such.
DocAnnotation:
    '@doc' '(' text=STRING ')';

MetaAnnotation:
    '@meta' '(' key=STRING ',' value=STRING ')';

// The value types TypeDB 3 has, plus any other name: `value rgba`, `value bool` parse — TypeDB's
// grammar admits a struct name here — and the validator refuses one it does not know, so the
// refusal is `define`'s and not the parser's, as the behaviour spec expects (`; fails`).
ValueType returns string:
    'string' | 'integer' | 'long' | 'double' | 'decimal' | 'boolean' | 'datetime-tz' | 'datetime'
    | 'date' | 'duration' | ID;

// ── Queries ─────────────────────────────────────────────────────────────────
//
// A pipeline is a sequence of stages, which is how TypeQLite 3.x composes read and write:
// `match ...; insert ...;` and `match ...; select $a, $b;` are both pipelines.

// 🔴 A pipeline is an ordered list of STAGES, as TypeQL 3's is: `match …; match …;` chains, and
// `match …; sort $x; limit 1; insert …;` streams the match's answers through each stage in turn
// (pipelines.feature, modifiers.feature). It opens with a stage that can start a stream and may end
// with `fetch` or `return`, which answer documents or a function's result and nothing after them.
//
// ⚠️ This replaced a FIXED order — `match (write)? (select)? (reduce)?` — which had been chosen to
// stop a file of consecutive queries collapsing into one pipeline. On TypeDB that IS one pipeline:
// a query is one pipeline, and a second `match` is a second stage reading the first's answers. A
// caller with several independent queries runs them one at a time (the CLI splits its input).
//
// `end;` closes a pipeline explicitly — TypeQL's terminator, which is how one document holds several
// queries (`examples/real-queries.typeqlite`).
Pipeline:
    (functions+=FunctionDefinition)* stages+=LeadStage stages+=Stage* (fetch=FetchStage | returnStage=ReturnStage)? (end?='end' ';')?;

// ── query-local functions ───────────────────────────────────────────────────
//
// `with fun get_names($p: person) -> { name }: match $p has name $n; return { $n };` — a function the
// query that follows may call (fetch.feature L1687). `-> { T, … }` answers a stream of tuples,
// `-> T, …` one tuple (or none); a `?` marks a value that may be absent. The body is a pipeline that
// ends in `return`. `define fun …` is the same definition without `with`, stored by the schema, and
// may carry `@doc`/`@meta` before its body (metadata.feature L153).
FunctionDefinition:
    with?='with' 'fun' name=ID '(' (parameters+=FunctionParameter (',' parameters+=FunctionParameter)*)? ')' '->' output=FunctionOutput annotations+=Annotation* ':' body=FunctionBody;

// The schema's own: no `with`, the same node type, so one evaluator serves both.
SchemaFunction infers FunctionDefinition:
    'fun' name=ID '(' (parameters+=FunctionParameter (',' parameters+=FunctionParameter)*)? ')' '->' output=FunctionOutput annotations+=Annotation* ':' body=FunctionBody;

FunctionParameter:
    variable=VAR ':' type=ValueType (optional?='?')?;

FunctionOutput:
      stream?='{' types+=FunctionOutputType (',' types+=FunctionOutputType)* '}'
    | types+=FunctionOutputType (',' types+=FunctionOutputType)*;

FunctionOutputType:
    type=ValueType (optional?='?')?;

FunctionBody:
    stages+=LeadStage stages+=Stage* returnStage=ReturnStage;

// `update` may lead too — and is refused for what it names unbound, as TypeDB refuses it, rather than
// failing to parse (update.feature L1097, L2046).
LeadStage:
    GivenStage | MatchStage | InsertStage | PutStage | DeleteStage | UpdateStage;

// `given $n: string, $p: person, $y: integer?;` — the rows the caller passes in, each variable typed
// and `?` when it may be absent (given.feature). Only ever the first stage.
GivenStage:
    'given' declarations+=GivenDeclaration (',' declarations+=GivenDeclaration)* ';';

GivenDeclaration:
    variable=VAR ':' type=ValueType (optional?='?')?;

Stage:
    MatchStage | InsertStage | PutStage | DeleteStage | UpdateStage | SelectStage | ReduceStage | SortStage
    | OffsetStage | LimitStage | DistinctStage | RequireStage;

type WriteStage = InsertStage | PutStage | DeleteStage | UpdateStage;

// `update $p has name "Bob"; $f links (friend: $x);` — replace what a bound thing owns or what a
// bound relation's role holds (update.feature). Parsed as patterns; the engine admits only `has`
// and `links` on variables an earlier stage bound, and says why for anything else.
UpdateStage:
    'update' patterns+=Pattern+;

// `sort $age desc, $name;` — ascending unless it says otherwise; stable, so ties keep stream order.
SortStage:
    'sort' keys+=SortKey (',' keys+=SortKey)* ';';

SortKey:
    variable=VAR (order=('asc' | 'desc'))?;

OffsetStage:
    'offset' count=INT ';';

LimitStage:
    'limit' count=INT ';';

DistinctStage:
    {infer DistinctStage} 'distinct' ';';

// `require $x, $y;` — keep only the answers where each is bound (after a `try`).
RequireStage:
    'require' variables+=VAR (',' variables+=VAR)* ';';

MatchStage:
    'match' patterns+=Pattern+;

InsertStage:
    'insert' patterns+=Pattern+;

// `put $o isa organization, has org-id "x";` — match-or-insert, in one statement.
PutStage:
    'put' patterns+=Pattern+;

// Two shapes, both real:
//   `delete $old of $p;`  detaches an attribute from its owner — how update is implemented.
//   `delete $i;`          deletes the thing itself — `skills-projection-target.ts`'s
//                         delete-then-insert idempotency, re-applied on every redelivered change.
//
// 🔴 The second was MISSED by the first scope survey and found by Phase 00's verification step,
// which re-derived the surface from every `.execute`/`.query` call site instead of re-reading the
// earlier summary. `skills-projection-target.ts` was not in that survey at all.
DeleteStage:
    'delete' deletions+=Deletion+;

SelectStage:
    'select' variables+=VAR (',' variables+=VAR)* ';';

// `reduce $c = count($y), $s? = sum($z) groupby $x;` — Phase 06 of the conformance feature. One
// row, or one per group, of value cells; `?` marks a reduction that may answer nothing.
ReduceStage:
    'reduce' reductions+=Reduction (',' reductions+=Reduction)* ('groupby' groups+=VAR (',' groups+=VAR)*)? ';';

// `$c = count($x)`, `$c = count`, `$m? = max($y)` — a bare `count` takes no parentheses
// (reduce.feature L92).
Reduction:
    variable=VAR (optional?='?')? '=' reducer=ID ('(' (argument=VAR)? ')')?;

// `delete $x;` (the thing), `delete has $n of $p;` (an ownership the match bound — never `has name $n
// of $p`, which TypeDB fails at PARSE: delete.feature L1090), `delete links
// (friend: $x) of $r;` (a role player), and the older `delete $n of $p;`. 🔴 Not `delete has name
// "Alex" of $x;` — TypeDB fails that at PARSE (delete.feature L1100): a delete names what the match
// bound, never a value.
Deletion:
    (
          // `delete try { $f; };` — run only when what it names is bound (delete.feature L2929). A
          // `try` inside it is a PARSE failure (L2995), so the block holds plain deletions only.
          optional?='try' '{' block+=PlainDeletion+ '}'
        | has?='has' target=VAR 'of' owner=VAR
        | links?='links' players=RolePlayers 'of' owner=VAR
        | target=VAR ('of' owner=VAR)?
    ) ';';

PlainDeletion infers Deletion:
    (
          has?='has' target=VAR 'of' owner=VAR
        | links?='links' players=RolePlayers 'of' owner=VAR
        | target=VAR ('of' owner=VAR)?
    ) ';';

// `return { $a, $b };` `return first $a;` `return count($x), sum($y);` `return check;` — TypeQL's
// function return, which a `fetch` sub-query also ends with (fetch.feature L882). Parsed in
// TypeQL's own shapes so that the shapes it refuses — an aggregate mixed with a variable,
// `return $age, count($name);` (L2260) — fail to parse for THAT reason, and not because `return`
// was unknown. Evaluating one is the functions phase's; the engine refuses it by name.
ReturnStage:
    'return' (
          '{' streamed+=VAR (',' streamed+=VAR)* '}'
        | selector=('first' | 'last') selected+=VAR (',' selected+=VAR)*
        | check?='check'
        | reductions+=ReturnReduction (',' reductions+=ReturnReduction)*
    ) ';';

ReturnReduction:
    reducer=ID ('(' (argument=VAR)? ')')?;

// ── fetch ───────────────────────────────────────────────────────────────────
//
// `fetch { "name": $n, "ages": [ $p.age ], "all": { $p.* }, "sub": [ match …; fetch { … }; ] };` —
// a JSON document per answer (fetch.feature). The shapes are TypeDB's, and so are the parse
// failures the spec names: `fetch;` (no object), `"all attributes": $p.*` (a spread is an object's
// entry, never a value), and a sub-query written outside `[ … ]`.
FetchStage:
    'fetch' body=FetchObject ';'?;

// A trailing comma is admitted — `fetch { "person name": $n, };` (fetch.feature L989).
FetchObject:
    {infer FetchObject} '{' (entries+=FetchEntry (',' entries+=FetchEntry)* ','?)? '}';

FetchEntry:
    FetchKeyValue | FetchAllAttributes;

FetchKeyValue:
    key=STRING ':' value=FetchValue;

// `$p.*` — every attribute the thing owns, keyed by its type.
FetchAllAttributes:
    variable=VAR '.' '*';

FetchValue:
    FetchObject | FetchList | FetchSingle | FetchAttribute | FetchExpression;

// `( match …; return count($n); )` — a sub-query answering ONE value, where `[ … ]` collects a list
// (fetch.feature L2174).
// 🔴 A `return` sub-query only: `( match …; fetch { … }; )` is a PARSE failure (fetch.feature L989).
FetchSingle:
    '(' subquery=FunctionBody ')';

// `$p.age` — scalar: `null`, or the one value; refused when the attribute can be owned more than once.
FetchAttribute:
    variable=VAR '.' attribute=ID;

// `[ $p.name ]`, `[ get_names($p) ]`, `[ match …; fetch { … }; ]` — a list.
FetchList:
    '[' (subquery=Pipeline | attribute=FetchAttribute | expression=Expression) ']';

// `$n`, `100`, `$k - 100`, `get_doc($t)` — a value.
FetchExpression:
    expression=Expression;

Pattern:
    ThingPattern | AnonRelationPattern | TypePattern | KindPattern | KindLabelPattern | LetPattern | ComparisonPattern
    | CallComparisonPattern | NegationPattern | DisjunctionPattern | OptionalPattern | IsPattern;

// ── nested patterns (negation.feature, disjunction.feature, optional.feature) ────────────────
//
// Each block is a conjunction of its own, evaluated against the answer the patterns around it bound:
// `not { … }` keeps the answer only if the block matches nothing, `{ … } or { … }` answers each
// branch's extensions, `try { … }` extends the answer if the block matches and keeps it unextended
// if it does not.
NegationPattern:
    'not' '{' patterns+=Pattern+ '}' ';';

DisjunctionPattern:
    branches+=PatternBlock ('or' branches+=PatternBlock)+ ';';

PatternBlock:
    '{' patterns+=Pattern+ '}';

OptionalPattern:
    'try' '{' patterns+=Pattern+ '}' ';';

// `$x is $y;` — the same concept.
IsPattern:
    left=VAR 'is' right=VAR ';';

// ── values (Phase 06) ───────────────────────────────────────────────────────

// `let $v = $a * 2;` — a value variable, assigned once.
// `let $key, $value in get_all_meta(person);` — one row per tuple the expression answers
// (metadata.feature). `variable` stays the first name so every single-variable reader is unchanged;
// `others` are the rest of the tuple, and `iterate` marks the `in` form.
LetPattern:
    'let' variable=VAR (',' others+=VAR)* (iterate?='in' | '=') expression=Expression ';';

// `$a > 10;` `$v == $a;` — a predicate over bound values, filtering the match.
ComparisonPattern:
    left=VAR comparator=Comparator right=Expression ';';

// `iid($x) == "0x…"` — a call on the left (expression.feature L1351). Only `iid`: no other caller puts
// an expression there. A pattern of its own, so `ComparisonPattern.left` stays a variable for every
// reader: the engine rewrites this one to `let $v = iid($x); $v == "0x…";` before anything reads it.
// `6 > 5` — a literal on the left (update.feature L207), rewritten the same way.
CallComparisonPattern:
    call=(IidCall | LeadLiteral) comparator=Comparator right=Expression ';';

LeadLiteral infers Expression:
    {infer LiteralExpression} literal=ExpressionLiteral;

IidCall infers Expression:
    {infer FunctionExpression} function='iid' '(' arguments+=FunctionArgument ')';

// `contains` and `like` are string predicates: `$n contains "Fun"`, `$n like "^[0-9]+$"`
// (match.feature L3889, L3948).
Comparator returns string:
    '==' | '!=' | '<=' | '>=' | '<' | '>' | 'contains' | 'like';

// Precedence climbing: `+ -` < `* / %` < unary `-` < `^` (right-associative) < atoms.
Expression:
    AdditiveExpression;

AdditiveExpression infers Expression:
    MultiplicativeExpression ({infer BinaryExpression.left=current} operator=('+' | '-') right=MultiplicativeExpression)*;

MultiplicativeExpression infers Expression:
    UnaryExpression ({infer BinaryExpression.left=current} operator=('*' | '/' | '%') right=UnaryExpression)*;

UnaryExpression infers Expression:
    {infer NegationExpression} '-' operand=UnaryExpression | PowerExpression;

PowerExpression infers Expression:
    AtomExpression ({infer BinaryExpression.left=current} operator='^' right=UnaryExpression)?;

// 🔴 An expression's literal is UNSIGNED: `10-1` must lex as `10` `-` `1`, so the terminals carry
// no sign (finding, Phase 06 review), and `-1` here is a `NegationExpression` over `1`. Outside an
// expression — `has age -5`, `@range(-5..5)` — the sign belongs to the `Literal` (below).
AtomExpression infers Expression:
      {infer LiteralExpression} literal=ExpressionLiteral
    | {infer VariableExpression} variable=VAR
    | {infer FunctionExpression} function=FunctionName '(' (arguments+=FunctionArgument (',' arguments+=FunctionArgument)*)? ')'
    | '(' Expression ')';

// `person`, `marriage:spouse` — a type named as a function's argument, as the schema functions take
// it: `get_doc(person)`, `get_relates_doc(person, person:newrole)` (metadata.feature).
//
// 🔴 **An argument, never an atom.** As an atom, `let $a = P524287Y;` — a duration literal this
// grammar does not have — parsed as a label, the engine refused it as "a type, not a value", and
// `typeql read query; fails` passed for that reason (expression.feature L825, found by this
// phase's audit of its own new passes). TypeDB parses a bare label nowhere else in an expression.
FunctionArgument infers Expression:
    {infer LabelExpression} label=ScopedLabel | Expression;

// The label itself — also what `$r label marriage:spouse` names.
ScopedLabel returns string:
    ID (':' ID)?;

// `floor`, `std::math::floor`, `std::string::len` — the built-ins, with or without their
// namespace; `string` is a value-type keyword, so a segment is a `ValueType`, which admits it.
// `label` is a keyword (`$t label person`), and also the schema function `label($t)`
// (expression.feature L1334) — admitted here by name.
FunctionName returns string:
    (ValueType | 'label' | 'iid') ('::' ValueType)*;

// `$s isa skill, has skill-id "x", has skill-name $n;`
// `$r isa step-dependency (dependent: $d, prerequisite: $p);`
// `$p has principal-type $old;`                       <- no isa; constrains an existing binding
// `$x sub person; $x owns name; $x label dog;`         <- a TYPE variable (Phase 05): the same head,
//                                                         told apart by its properties
ThingPattern:
    variable=VAR properties+=Property (',' properties+=Property)* ';';

// `person owns $x;` `writer sub $x;` `employment relates $x;` — a type named as the subject, with
// a variable somewhere in its properties. Phase 05 of the conformance feature.
TypePattern:
    subject=ID properties+=Property (',' properties+=Property)* ';';

// `entity $x;` `relation $t;` `attribute $x;` `relation $x label connection;` — a kind filter on a
// type variable, optionally with properties.
KindPattern:
    kind=Kind variable=VAR (properties+=Property (',' properties+=Property)*)? ';';

// `entity person;` — a label's kind, asserted (update.feature L104, where a write refuses it).
KindLabelPattern:
    kind=Kind label=ID ';';

// `(owner: $s, step: $st) isa skill-composition;` — an unbound relation, never referred to again.
// `(employee: $x);` — with no `isa`, a relation of any type (negation.feature L608).
// `employment (employee: $p, employer: $e);` — the type before the players (fetch.feature L882).
// Either form may own attributes: `(friend: $x) isa friendship, has ref 0;` (delete.feature L221).
// `(employee: $x) isa $r` — the type through a variable an earlier stage bound (insert.feature L2140).
AnonRelationPattern:
      players=RolePlayers ('isa' (type=ID | typeVariable=VAR))? (',' properties+=HasProperty)* ';'
    | type=ID players=RolePlayers (',' properties+=HasProperty)* ';';

Property:
    IsaProperty | HasProperty | LinksProperty | LabelProperty | SubProperty | OwnsProperty
    | PlaysProperty | RelatesProperty | IidProperty | ValueProperty;

// `$x value integer` — the attribute types holding that value type (match.feature L3764).
ValueProperty:
    'value' valueType=ValueType;

// `$x iid 0x1e…` — the one concept with that iid, or none (match.feature L948). An iid is the engine's
// to assign: a write refuses it, and `$x iid V123` does not parse (insert.feature L2715).
IidProperty:
    'iid' iid=IID;

// `isa person`, `isa $t` (a type variable), `isa! person` (the exact type, no subtypes).
// An attribute instance takes its value as `has` does (ADR-006): `$n isa name "John"`,
// `$a isa age > 18` in a match, `insert $_ isa name == $a` (expression.feature L1407) — and
// `insert $x isa age > 18` parses, to be refused by name (insert.feature L1619).
IsaProperty:
    (exact?='isa!' | 'isa') (type=ID | typeVariable=VAR)
    (players=RolePlayers | comparator=Comparator compared=Expression | value=Literal)?;

// ── type properties (Phase 05) ──────────────────────────────────────────────
//
// Each names a type or a type variable; a ThingPattern carrying one is a TYPE pattern, and the
// interpreter refuses a head that mixes `has`/`links` with these.
// `$t label person`, `$r label marriage:spouse` — a role type is labelled through its relation
// (metadata.feature L73), as the solver's universe already names it.
LabelProperty:
    'label' label=ScopedLabel;

// `$x sub parenthood:parent` — a role type, under the roles that specialise it (define.feature L635).
SubProperty:
    (direct?='sub!' | 'sub') (type=ScopedLabel | typeVariable=VAR);

// `$p owns name @card(5..)` parses — TypeDB's grammar admits it — and the engine refuses it.
OwnsProperty:
    'owns' (attribute=ID | attributeVariable=VAR) annotations+=Annotation*;

PlaysProperty:
    'plays' (role=RoleName | roleVariable=VAR);

// `$x relates $_ as child` — a role that is, or specialises, one named `child`; `as parentship:child`
// names the one role (match.feature L3546). `as` is to roles what `sub` is to types.
RelatesProperty:
    'relates' (role=ID | roleVariable=VAR) ('as' (specialises=ScopedLabel | specialisesVariable=VAR))?;

// The value is a literal when constraining, a variable when binding for output.
// `has $a` — any attribute, of whatever type (163 uses in the behaviour spec).
// `has age > 5`, `has name == $n` — a comparison on the owned value (a write takes `==` as the value).
HasProperty:
    'has' (
          attribute=ID (comparator=Comparator compared=Expression | value=Literal | valueVariable=VAR | '(' expression=Expression ')')?
        // `has $_ 9`, `has $a "value"` — an attribute of any type holding that value (match.feature L4501);
        // `has $b < 15` parses too, and a write refuses `$b` as both a type and an attribute (update.feature L488).
        | valueVariable=VAR (value=Literal | comparator=Comparator compared=Expression)?
    );

LinksProperty:
    'links' players=RolePlayers;

RolePlayers:
    '(' entries+=RolePlayer (',' entries+=RolePlayer)* ')';

// `employee: $p`, or `$p` alone — the role left for the schema to decide (optional.feature L46).
// `($r: $x)` — the role as a type variable, bound to the role type it plays (negation.feature L365).
RolePlayer:
    ((role=ID | roleVariable=VAR) ':')? player=VAR;

// 🔴 `DatetimeLiteral`, then `DateLiteral`, then `DoubleLiteral`, then `IntLiteral`, mirroring the
// terminal order in `terminals.langium` — all begin with digits, and the alternation is resolved by
// the token the lexer already chose.
//
// **Added because a downstream feature needed them, which is this grammar's rule for every construct.**
// `ValueType` has admitted `boolean` and `datetime` since day one, but nothing could *write* one:
// `workbench.schema.typeqlite` declares two boolean and two datetime attributes, and real call sites
// emit `has is-latest true` and `has created-at 2026-09-03T10:00:00`. Neither parsed
// (Amendment 1(d) of ADR-038, in the monorepo this engine came from).
//
// **The date and double literals arrived the same way, 2026-09-11.** `fetch.feature`'s Background
// inserts `has end-date 2021-01-01` and `has karma 123.4567891`; the behaviour spec is the caller.
//
// **Signed here, unsigned in an expression (Phase 06).** The numeric terminals carry no sign, so
// that `10-1` is a subtraction; a `has age -5` or `@range(-5..5)` takes its `-` as the literal's
// `negative` flag, and `literalText` applies it.
Literal:
    StringLiteral | DatetimeTzLiteral | DatetimeLiteral | DateLiteral | DurationLiteral | BooleanLiteral
    | SignedDecimalLiteral | SignedDoubleLiteral | SignedIntLiteral;

// An expression's literal carries no sign — `-1` there is a `NegationExpression` over `1`.
ExpressionLiteral infers Literal:
    StringLiteral | DatetimeTzLiteral | DatetimeLiteral | DateLiteral | DurationLiteral | BooleanLiteral
    | DecimalLiteral | DoubleLiteral | IntLiteral;

// `P1Y2M3DT4H5M6.789S` — a duration, stored as TypeDB holds one: months, days and exact time.
DurationLiteral:
    value=DURATION;

// `+ 15` is a literal too — TypeDB reads `$p has $b + 15` as a value for `has $b` (update.feature L479).
SignedDecimalLiteral infers DecimalLiteral:
    (negative?='-' | '+')? value=DECIMAL;

SignedDoubleLiteral infers DoubleLiteral:
    (negative?='-' | '+')? value=DOUBLE;

SignedIntLiteral infers IntLiteral:
    (negative?='-' | '+')? value=INT;

// `10.2dec`, `5dec` — TypeDB's exact decimal, before DOUBLE and INT which are its prefixes.
DecimalLiteral:
    value=DECIMAL;

StringLiteral:
    value=STRING;

// `2024-06-04T00:00:00+0010`, `2024-06-04T00:00:00 Europe/Belfast` — a datetime with its zone,
// which is its own value type (`datetime-tz`). Before DATETIME, which is its prefix.
DatetimeTzLiteral:
    value=DATETIME_TZ;

DatetimeLiteral:
    value=DATETIME;

DateLiteral:
    value=DATE;

DoubleLiteral:
    value=DOUBLE;

// Keywords rather than a terminal: `true` also matches `ID`, and Langium resolves that with a
// keyword token carrying `longer_alt: ID` — so `trueish` stays one identifier.
BooleanLiteral:
    value=('true' | 'false');

IntLiteral:
    value=INT;
