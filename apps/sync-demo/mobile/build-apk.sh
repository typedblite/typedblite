#!/usr/bin/env bash
# Build the debug APK: mobile/android/app/build/outputs/apk/debug/app-debug.apk
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
cd "$HERE"
[ -d android ] || npx cap add android
npx cap sync android
cd android && ./gradlew --quiet assembleDebug
echo "$HERE/android/app/build/outputs/apk/debug/app-debug.apk"
