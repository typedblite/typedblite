---
kind: standard
status: active
applies-to: any effort spanning more than one session or more than one implementation phase
operationalises: []
---

# Multi-Phase Lifecycle Standard

> **Status:** Active · **Adopted:** 2026-11-12, with the [TypeQLite Editor](../../planning/editor/editor.feature.md)
> feature, the first multi-phase work planned in this repository · **Applies to:** any effort
> spanning more than one session or more than one implementation phase.
>
> Adapted from downstream-app's Multi-Phase Lifecycle Standard (2026-08-27), where this repository's
> code was first built. It differs in three places, all of them for the same reason: downstream-app
> has things that do not exist here. That repository has a `dev` integration branch and a promotion
> ladder, a branch register, and SCM operations that enforce the gate. This repository has `main`,
> no register, and no tooling, so the gate is checked by hand.

## The rule

**Multi-phase work has a feature document. Every phase has a branch, a checklist, and a summary.**

A phase is not complete until its checklist is done **and** its summary is written. "The code
works" is not the exit condition. The summary is what a later session reads instead of
re-deriving the phase from its diff.

## Artifacts

| Artifact | Path | Written |
| -------- | ---- | ------- |
| Initiative document | `docs/planning/<initiative>/<initiative>.initiative.md` | Before its first feature starts, and **only when work spans several features** |
| Feature document | `docs/planning/<feature>/<feature>.feature.md` | Before phase 00 starts |
| Phase checklist | `docs/planning/<feature>/phases/<NN>-<slug>/checklist.md` | At the start of that phase |
| Phase summary | `docs/planning/<feature>/phases/<NN>-<slug>/summary.md` | At the end of that phase |
| Parking-lot entry | The feature document's **Deferred** section | Whenever work is deferred |

Features that belong to an initiative live under its folder:
`docs/planning/<initiative>/<feature>/<feature>.feature.md`.

**An initiative document exists only when one is needed.** Its job is the thing a feature document
cannot hold: **the dependency graph between features, and the sequencing that follows from it**.
It does not repeat their goals, and it has no phases of its own. An initiative that starts
describing implementation has become a feature document with the wrong name. When the work is one
deliverable with phases that run in a straight line, a phase table states the sequence, and an
initiative adds a document without adding information.

**Phase checklists are authored when the phase starts, not up front.** A checklist written five
phases early encodes assumptions the intervening phases have already invalidated. It is then either
followed wrongly or quietly ignored. The feature document's phase table is the forward plan, and the
checklist is the contract for the phase actually being worked.

## Branches

```
main
└── feat/<feature>
    └── phase/<feature>/<NN>-<slug>
```

The feature branch is cut from `main`. Each phase branch is cut from the feature branch and merges
back into it. **It never merges into `main` directly**, which would put half a feature on the branch
everything else is cut from. The feature branch merges into `main` when the feature completes. A
phase branch is deleted once merged.

🔴 **An initiative has no branch.** It is a planning artifact, not a unit of work. Each of its
features is cut from `main` in the ordinary way. A branch named after an initiative would be a
long-lived integration branch by another name.

If `main` moves while a feature is open, the feature branch takes `main` (merge, not rebase, once
pushed), and the open phase branch then takes its feature branch. **A phase branch never syncs from
`main` directly.**

## Exit gate

A phase closes when:

- [ ] Every checklist item is ticked, or explicitly struck through with a reason.
- [ ] `summary.md` records the goal, the scope, what was actually built, the exit evidence, and the
      handoff.
- [ ] Build, typecheck and test are green for what the phase touched, and the conformance run has not
      regressed ([ADR-005](../../architecture/adr-005-typedb-s-behaviour-specification-is-typedblite-s-conformance-oracle.md)).
- [ ] Anything deferred is in the feature document's **Deferred** section, not only in a commit
      message.
- [ ] The phase branch is merged into the feature branch and deleted.
- [ ] 🔴 **The feature document's phase table is updated.** The phase's row becomes `Complete`, and
      its name becomes a link to the `summary.md` just written.

  **The check, until something automates it:** a row claiming `Complete` must have a
  `phases/<NN>-*/summary.md`, and a row not claiming it must not.

  **Why the item exists.** In downstream-app, an audit of ten feature documents found three whose
  tables had drifted. Two read *"Not started"* for every phase of a feature already complete and
  merged. One read *"In progress"* a day after the phase closed. Nobody had skipped a step: the step
  was not written down. The table is the forward plan that a later session reads first, and a
  completed feature whose plan says nothing has started is worse than no table at all.

## The failure this prevents

Work that spans sessions loses its reasoning between them. The summary is the handoff. Without it,
the next session reads the diff and reconstructs the intent, and that is how a deferred decision
gets silently implemented the other way.
