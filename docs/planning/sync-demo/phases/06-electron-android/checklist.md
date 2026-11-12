---
kind: checklist
status: complete
feature: sync-demo
phase: 06-electron-android
---

# Phase 06 — Electron and Android

**Branch:** `phase/sync-demo/06-electron-android`, from `feat/sync-demo` · **Opened:** 2026-11-12

**Goal.** The desktop and phone devices: the same page in an Electron window and in a Capacitor app,
each with storage of its own.

## Electron

- [x] `src/electron/main.ts`: one `BrowserWindow` on `?device=electron`, with `contextIsolation`
      and `sandbox`. `--profile` sets its own `userData`, so its OPFS and service worker are its own.
      It also takes `--url` and `--fresh`. Bundled to `.build/electron-main.cjs` by the client build.
      Type-checked as a fourth program
- [x] `test-browser/electron.test.ts` launches the real Electron app through Playwright's
      `_electron`, with `ELECTRON_RUN_AS_NODE` and `VSCODE_*` stripped. It checks that the window
      is its own device, and syncs both ways with a headless device through the server. **2 of 2**

## Android

- [x] `mobile/` is the Capacitor root, with its own `package.json`. Capacitor treats the nearest
      `package.json` as the app root, so a folder named `android/` beside the demo's own package
      clashed with the native platform folder. `capacitor.config.json` loads
      `http://localhost:4300/?device=android` (cleartext, because it is localhost through
      `adb reverse`)
- [x] `mobile/setup.sh` installs a JDK 21 (Adoptium) if there is no `javac`, the SDK command-line
      tools, platform 35 (which Capacitor 7 compiles against), build-tools 35, the API 34 emulator
      image, the `typedblite-demo` AVD, and the native project. It is idempotent
- [x] `mobile/build-apk.sh` runs `cap add` and `cap sync`, then `gradlew assembleDebug`. The native
      project `mobile/android/` is generated, and gitignored
- [x] `mobile/start-emulator.sh` boots the AVD (with the WSL libpulse workaround), installs the APK,
      and runs `adb reverse tcp:4300`. It refuses with the fix when `/dev/kvm` is not writable
- [x] Nx targets: `android-setup`, `android-apk` and `android-emulator`
- [x] **The APK builds**: `dev.typedblite.syncdemo`, compileSdk 35, the INTERNET permission, about
      4 MB, and a bundled configuration pointing at the demo server
- [ ] 🔴 **Not run on a device in this session.** The user is not in the `kvm` group, so the emulator
      cannot boot here (Phase 00). The driver's Android path is written in Phase 07, and must be run
      once with `sudo chmod 666 /dev/kvm` before the demo is presented

## Dependencies and security

- [x] Electron's install script is approved in the root `allowScripts`, so its binary downloads
- [x] 🔴 `npm audit` on the Phase 00 versions found:
  - **critical**: `@capacitor/android` below 7.6.9 can load remote content at the app origin;
  - **critical**: `tar`, through `@capacitor/cli`;
  - **high**: Electron 38, with advisories fixed only from 39 up to 42.11.16;
  - **high**: `extract-zip`.

  Moved to **Capacitor 7.6.10** and **Electron 42.11.18**, each released more than two weeks ago.
  42.11.18 uses Electron's own patched zip extractor. **No advisory remains on any of the demo's
  dependencies.** Phase 00's decision is corrected in place
- [x] After the upgrade, the APK was rebuilt on Capacitor 7.6.10, and `test-browser` (the PWA and
      Electron) passes **6 of 6**

## Close

- [x] `summary.md`, and the Phase Plan row
