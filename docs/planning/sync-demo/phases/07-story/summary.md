---
kind: summary
status: complete
feature: sync-demo
phase: 07-story
---

# Phase 07 — Summary

**Closed:** 2026-11-12 · **Checklist:** [checklist.md](checklist.md)

## What exists now

`nx run sync-demo:demo` opens every device and runs the original's nine-step story. Each step is
proven by convergence on an explicit expectation. Captions appear on the control page, Pause and Play
hold the story, and `--record` writes one silent video per window plus an `.srt`. `--headless`
makes the whole story a test (`test-browser/story.test.ts`).

## Two real defects, found by the driver

1. **A convergence check that only compared stores** passed before the change it was meant to wait
   for. A convergence now always comes with what the stores must hold.
2. **The page rebuilt its list on every sync**, and lost the click being made. It now updates the
   list in place.

## Not done in this session

A windowed run, which would open windows on the user's desktop, and a run with the phone, which needs
KVM. Both are one command away, and are in the README's checklist (Phase 08).
