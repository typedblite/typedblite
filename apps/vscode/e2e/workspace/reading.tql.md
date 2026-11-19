# Reading list

A schema first:

```typeql
define
attribute title, value string;
entity book, owns title;
```

Then one book, and a question about it:

```typeql
insert $b isa book, has title "Dune";
```

```typeql
match $b isa book, has title $t;
select $t;
```
