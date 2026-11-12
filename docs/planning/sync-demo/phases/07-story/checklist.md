---
kind: checklist
status: complete
feature: sync-demo
phase: 07-story
---

# Phase 07 — The story

**Branch:** `phase/sync-demo/07-story`, from `feat/sync-demo` · **Opened:** 2026-11-12

**Goal.** One command opens every device and tells the story, each step proven by convergence, with
captions instead of narration.

## At the start

- [x] Phase 06's clean gate, forgotten at its close, ran first: 7 projects green, conformance
      unchanged

## Build

- [x] The demo server holds a story state (active, paused, step, caption) under `/api/state`, with
      `POST /api/story/pause`, `play` and `toggle`. The control page shows the caption, an amber
      "Paused" banner and a ⏸/▶ button, and Space toggles it. Devices are shown by label ("Browser
      (pwa)")
- [x] `src/driver/environment.ts`: `electronPath()` and `cleanEnvironment()`, shared by the driver and
      the tests
- [x] `src/driver/demo.ts` (`nx run sync-demo:demo`) opens the PWA (a persistent Chromium profile),
      the Electron app, the phone (when `adb devices` lists one and the port is 4300) and the control
      page, waits for every device to connect, and runs the nine steps of the original:
  1. three devices, one hub;
  2. write anywhere;
  3. edit elsewhere;
  4. the desktop loses its connection;
  5. reconnect;
  6. the hub goes down;
  7. the hub comes back;
  8. truly offline;
  9. back online.
- [x] Flags: `--fresh`, `--auto`, `--open`, `--no-android`, `--start-playing`, `--record` (one silent
      WebM per window, named for the window, plus `captions.srt` timed from the first window), and
      `--headless` (no windows; implies `--auto`). It starts PAUSED until ▶ Play. Pause holds before
      every step and every action
- [x] **No narration.** The captions carry the story (founder's decision)

## Found while building

- [x] 🔴 **Agreement is not convergence.** The first driver passed step 2 "in 0.0 s", because every
      store agreed on the state *before* the new task. Step 3 caught it: the stores agreed, but not on
      the edit. Every action now waits until its own device shows it, and every convergence takes the
      step's expectation ("has 'Book the taxi'", "it is done")
- [x] 🔴 **The page lost clicks.** It rebuilt the whole list on every state update (twice per sync), so
      a checkbox being clicked was detached from the page. Pausing the story lined the rebuilds up
      with the driver's click every time. The list now updates in place, keyed by task id. A person's
      click would have been lost the same way
- [x] The desktop window sets `backgroundThrottling: false`, so a window behind others keeps syncing
      at full rate (tried first as the cause of the lost click; it was not the cause, but keeping the
      sync rate is right regardless)

## Proof

- [x] Headless runs of the whole story: every step converges in 0.8–2.1 s. Five complete runs,
      including two with a pause of 6–8 s mid-story through the API, then Play
- [x] `--record`: three WebMs (`pwa`, `electron`, `control`) and `captions.srt`. Frames extracted
      from the end of the PWA and control videos show the expected nine tasks, and the 9/9 caption
- [x] `test-browser/story.test.ts` runs the driver headless as a child process, and asserts exit 0,
      nine ✓ steps, and the desktop's "3 changes waiting to sync". `test-browser`: **7 of 7**
- [ ] **Not run windowed, or with the phone, in this session.** Windowed would open windows on the
      user's desktop; the phone needs KVM. Windowed differs from headless only in window placement
- [x] Clean gate: 7 projects green. Conformance at 1742 · 1 · 12 · 1 / 1756

## Close

- [x] `summary.md`, and the Phase Plan row
