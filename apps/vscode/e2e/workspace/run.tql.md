# Run me

```typeql
define attribute title, value string; entity book, owns title;
```

```typeql
insert $b isa book, has title "Dune";
```

```typeql
match $b isa book, has title $t; select $t;
```

```typeql
insert $x isa nonexistent-type;
```

```typeql
match $b isa book; select $b;
```
