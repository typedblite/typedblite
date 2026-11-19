---
kind: checklist
status: complete
feature: engine-host
phase: 04-mcp
---

# Phase 04 — MCP

**Branch:** `phase/engine-host/04-mcp`, from `feat/engine-host` · **Opened:** 2026-11-19 ·
**Feature:** [Engine host](../../engine-host.feature.md)

**Goal.** MCP as the fifth transport: tools only, reads by default, a write tier that is opt-in, and HTTP MCP on
loopback only.

## Decisions

- [x] Where MCP lives: in the host (founder, 2026-11-19), recorded in ADR-011 D10

## Build

- [x] `@modelcontextprotocol/sdk` installed; 12 npm lockfile URLs verified against registry.npmjs.org
- [x] `src/mcp-policy.ts`: the tiers, and `checkCall` for the read tier
- [x] `src/mcp.ts`: the server over the low-level `Server` (the descriptors' JSON Schema goes out as it is, with no
      zod), stdio, and stateless Streamable HTTP
- [x] `--mcp`, `--mcp-http` (`--host`, `--port`), `--mcp-write` as extra modes of `defineApp`
- [x] The HTTP fence shared with MCP, and an `Origin` check added to it

## Specs

- [x] The read tier lists the read operations; the write tier lists all twelve; an operation with no input schema is not a tool
- [x] A read-tier write and define are refused, naming `--mcp-write`, and the store is unchanged
- [x] An undefine, which the classifier sends down the read path, cannot change the schema
- [x] A missing location is refused and no file appears; an existing store is byte for byte as it was after a read
- [x] Operations outside the tier are refused by name; an unknown tool differently; bad input gets the validator's message
- [x] **Parity:** MCP joins the CLI, sidecar, REPL and HTTP in the same flow (five transports)
- [x] The built process: stdio and HTTP MCP with the SDK's own clients; a non-loopback `--host` or a bad `--port`
      exits 2 naming it and never listens; `--mcp-write` alone exits 2; 403, 405, 404 and 400 on the HTTP endpoint
- [x] Three mutations in the policy and two in the fences each fail a spec

## Checks

- [x] `npm run gate -- --quick`
- [ ] WASM, browser, e2e and clean-room steps: not run

## Outputs

- [x] `summary.md`; ADR-011 D8 and D10; the feature and initiative status; the README and `AGENTS.md`
- [ ] Merged into `feat/engine-host`
