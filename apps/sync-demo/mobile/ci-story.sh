#!/usr/bin/env bash
# Run the whole story with the phone in it, on a device `adb` already lists: CI's emulator job.
# Needs the demo built (sync-demo:build), the APK (sync-demo:android-apk), a display, and ANDROID_HOME.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
ADB="$ANDROID_HOME/platform-tools/adb"

"$ADB" reverse "tcp:$DEMO_PORT" "tcp:$DEMO_PORT"
"$ADB" install -r "$HERE/android/app/build/outputs/apk/debug/app-debug.apk"

log="$(mktemp)"
if ! DEMO_DEBUG=1 node "$HERE/../out/driver/demo.js" --headless --fresh 2>&1 | tee "$log"; then
  echo "--- the device's log, WebView and app lines:" >&2
  "$ADB" logcat -d | grep -i -E 'chromium|capacitor|typedblite|AndroidRuntime' | tail -n 100 >&2 || true
  exit 1
fi

# The driver skips a phone it cannot find and still succeeds, which here would test nothing.
if ! grep -q 'Opened: Browser, Desktop, Phone' "$log"; then
  echo "The story ran without the phone." >&2
  exit 1
fi
