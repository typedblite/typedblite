# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for a security problem.** Report it privately, in either of these ways:

1. **GitHub private vulnerability reporting** (preferred): use
   [Report a vulnerability](https://github.com/dave-jackson-dev/typedblite/security/advisories/new)
   on the repository's Security tab.
2. **Email** `security@typedblite.dev`.

Please include what you found, how to reproduce it, the version affected, and the impact you expect.

## What to expect

- An acknowledgement within **48 hours**.
- An assessment and a plan, or questions, within **7 days**.
- A fix released as a patch version, with a security advisory, and credit to you if you want it.
- Please give us a reasonable time to ship a fix before you disclose publicly. We aim to be done within
  90 days, and sooner for serious issues.

## Supported versions

TypeDBLite is pre-1.0. Security fixes are made to the **latest released minor version** only.

| Version | Supported |
| ------- | --------- |
| latest `0.x` release | Yes |
| anything older | No |

## Scope

In scope: the packages published from this repository (`@typedblite/runtime`, `@typedblite/language`,
`@typedblite/content-revision`, `typedblite-cli`), the VS Code extension, and the replication hub and
spoke code.

Out of scope: TypeDB itself, which is a separate product (report it to [TypeDB Ltd](https://typedb.com)),
and the vendored behaviour specification under `libs/conformance/spec/`.

TypeDBLite is an embedded engine. It trusts the schema and queries given to it, and the stores it opens.
Run the replication hub only on a network you trust until its authentication is documented.
