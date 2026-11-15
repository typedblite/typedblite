// TypeQLite terminals.
//
// Deliberately NOT reusing the parent monorepo's scripting-language terminals.langium: that file is built around
// PascalCase/HYPHENATED_NAME identifiers for a modelling language written by humans in prose
// style. TypeQLite identifiers are lowercase-hyphenated (`skill-id`, `membership-key`), variables
// are `$`-prefixed, and comments are `#` — three incompatible lexical decisions.

// A `$`-prefixed query variable: $s, $st, $child — and `$0_leading_digit_allowed`, which
// match.feature writes (Phase 05).
// A variable starts with a letter or a digit, ASCII or not (`$人`, `$0_leading_digit_allowed`); `$_` alone
// is the anonymous variable, and a leading underscore is otherwise refused (match.feature L5561, L5591).
terminal VAR returns string: /\$(?:_(?![A-Za-z0-9_\-\u0080-\uFFFF])|[A-Za-z0-9\u0080-\uFFFF][A-Za-z0-9_\-\u0080-\uFFFF]*)/;

// Type and attribute labels. Hyphens are part of the token, which is why `skill-id` lexes as one
// identifier rather than a subtraction. ⚠️ Since Phase 06 TypeQLite HAS arithmetic here, so `$a-1`
// is one variable (VAR admits the hyphen too) and `$a - 1` is a subtraction — the space decides,
// as it does in TypeDB. The numeric terminals below carry NO sign for the same reason: `10-1`
// is `10` `-` `1`, and a literal's sign is the grammar's (`Literal`, `NegationExpression`).
// `P1Y2M3DT4H5M6.789S`, `P66W`, `PT0S` — an ISO 8601 duration (expression.feature L810). Before ID,
// which would otherwise take `P1Y` as a label; it needs at least one component, so `P` and `PT`
// alone are still identifiers.
terminal DURATION returns string: /P(?:[0-9]+W|(?=[0-9]|T[0-9])(?:[0-9]+Y)?(?:[0-9]+M)?(?:[0-9]+D)?(?:T(?=[0-9])(?:[0-9]+H)?(?:[0-9]+M)?(?:[0-9]+(?:\.[0-9]+)?S)?)?)(?![a-zA-Z0-9_-])/;

// A label starts with a letter or `_`, ASCII or not (`人`, `_underscore-relation`) — never a digit (L5518).
terminal ID returns string: /[A-Za-z_\u0080-\uFFFF][A-Za-z0-9_\-\u0080-\uFFFF]*/;

// Double- or single-quoted — `has name 'Steve'` (expression.feature L1002) beside `"Alice"`.
terminal STRING returns string: /"(\\.|[^"\\])*"|'(\\.|[^'\\])*'/;

// `0x1e00000000001234567890` — a concept's iid (match.feature L734). Before every numeric terminal,
// which would otherwise take the `0` and leave `x1e…` to ID.
terminal IID returns string: /0x[0-9a-fA-F]+/;

// `2024-06-04T00:00:00+0010`, `…Z`, `… Europe/Belfast` — a datetime WITH its zone, TypeDB's
// `datetime-tz` value type. Declared before DATETIME because DATETIME is its prefix and Chevrotain
// takes the first match. The space before an IANA zone name is part of the token, and a zone
// name is any number of `/`-separated parts (`America/Argentina/Buenos_Aires`, `Etc/GMT+1`).
//
// 🔴 **Declared before INT, and that order is the whole reason this lexes.** Chevrotain takes the
// first pattern that matches at a position, not the longest — so with INT first, `2026-09-03T10:00:00`
// would lex as the integer `2026` and the rest would be a parse error nobody could read.
//
// **Seconds precision, an OPTIONAL fractional part, no timezone.** This repository's callers emit
// `d.toISOString().replace('Z', '').slice(0, 19)`; the behaviour spec's `fetch.feature` inserts
// `2020-01-01T13:13:13.999`, and that caller arrived 2026-09-11. ⚠️ `attr.value` is compared as
// text, so `…:13` and `…:13.000` are two texts for one instant and will never match each other —
// a caller mixing spellings gets what it wrote. Minutes-only (`2026-09-03T10:00`) is TypeDB's too,
// and the engine stores it with `:00`.
//
// A year may carry a sign and more digits — `+262142-12-31`, `-262143-01-01` (expression.feature
// L506) — and the seconds may be left out: `…T00:00+02:00` (L704), as ISO 8601 and TypeDB allow.
terminal DATETIME_TZ returns string: /(?:[+-][0-9]{4,}|[0-9]{4})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(\.[0-9]+)?)?([+-][0-9]{2}:?[0-9]{2}|Z| [A-Za-z_]+(\/[A-Za-z0-9_+-]+)+)/;

terminal DATETIME returns string: /(?:[+-][0-9]{4,}|[0-9]{4})-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}(?::[0-9]{2}(\.[0-9]+)?)?/;

// `2021-01-01` — after DATETIME (which needs the `T…`), before INT. `fetch.feature`, 2026-09-11.
terminal DATE returns string: /(?:[+-][0-9]{4,}|[0-9]{4})-[0-9]{2}-[0-9]{2}/;

// `10.2dec`, `5dec` — an exact decimal (Phase 06). Before DOUBLE and INT, which are its prefixes.
terminal DECIMAL returns string: /[0-9]+(\.[0-9]+)?dec/;

// `123.4567891` — before INT, for the same first-match reason as DATETIME. Stored as its text.
// `1.5`, `1.0e-2`, and `1e-2` — an exponent needs no fraction (insert.feature L1555).
terminal DOUBLE returns string: /[0-9]+(\.[0-9]+)?[eE][+-]?[0-9]+|[0-9]+\.[0-9]+/;

terminal INT returns number: /[0-9]+/;

hidden terminal WS: /\s+/;
hidden terminal SL_COMMENT: /#[^\n\r]*/;
