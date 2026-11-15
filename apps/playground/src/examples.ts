/**
 * The programs the playground offers. A statement that follows a write or a query ends with `end;`:
 * in TypeQL 3 a `match` after an `insert` is the next stage of the same pipeline, not a new query.
 * Each is a schema, some data and queries, and each is run by
 * `test/examples.test.ts` on the real engine: an example that stopped working would be the first thing
 * a visitor sees break.
 */
export interface Example {
  readonly id: string;
  readonly title: string;
  readonly summary: string;
  readonly source: string;
}

export const EXAMPLES: readonly Example[] = [
  {
    id: 'people-and-companies',
    title: 'People and companies',
    summary: 'A relation that joins two kinds of thing, and a query across it.',
    source: `# A schema: people and companies, joined by an employment relation.
define
  attribute name, value string;
  entity person, owns name @key, plays employment:employee;
  entity company, owns name @key, plays employment:employer;
  relation employment, relates employee, relates employer;

# Some data.
insert
  $alice isa person, has name "Alice";
  $bob isa person, has name "Bob";
  $acme isa company, has name "Acme";
  (employee: $alice, employer: $acme) isa employment;
  (employee: $bob, employer: $acme) isa employment;
end;

# Who works where?
match
  $p isa person, has name $who;
  $c isa company, has name $where;
  (employee: $p, employer: $c) isa employment;
select $who, $where;
sort $who;
`,
  },
  {
    id: 'types-that-inherit',
    title: 'Types that inherit',
    summary: 'Ask for a supertype and get its subtypes too.',
    source: `# animal is abstract: there are dogs and cats, never a bare animal.
define
  attribute name, value string;
  entity animal @abstract, owns name @key;
  entity dog sub animal;
  entity cat sub animal;

insert
  $rex isa dog, has name "Rex";
  $tom isa cat, has name "Tom";
  $fido isa dog, has name "Fido";
end;

# Asking for animals returns the dogs and the cats.
match $a isa animal, has name $n;
select $a, $n;
sort $n;
end;

# Asking for dogs returns only the dogs.
match $d isa dog, has name $n;
select $n;
sort $n;
`,
  },
  {
    id: 'counting-and-fetching',
    title: 'Counting and fetching',
    summary: 'Aggregate with reduce, and ask for the answer as JSON.',
    source: `define
  attribute title, value string;
  attribute minutes, value integer;
  entity talk, owns title @key, owns minutes;

insert
  $a isa talk, has title "Local-first basics", has minutes 30;
  $b isa talk, has title "Typed graphs in the browser", has minutes 45;
  $c isa talk, has title "Syncing offline edits", has minutes 20;
end;

# How many, and how long on average?
match $t isa talk, has minutes $m;
reduce $n = count, $average = mean($m), $longest = max($m);
end;

# The same talks as JSON documents.
match $t isa talk, has title $title, has minutes $m;
sort $m desc;
fetch { "talk": $title, "minutes": $m };
`,
  },
];
