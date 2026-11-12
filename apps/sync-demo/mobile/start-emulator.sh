#!/usr/bin/env bash
# Boot the AVD, install the app, and forward the demo server into the device, so its WebView loads
# http://localhost:4300 — a secure context, which OPFS and the service worker need.
#
# 🔴 Under WSL the emulator's qemu needs libpulse, which is not installed by default. Install it
# (sudo apt-get install libpulse0), or extract it without sudo into ~/Android/hostlibs:
#   mkdir -p ~/Android/hostlibs/debs && cd ~/Android/hostlibs/debs && apt-get download libpulse0 \
#     libsndfile1 libasyncns0 libflac12t64 libvorbisenc2 libvorbis0a libogg0 libopus0 libmpg123-0t64 \
#     libmp3lame0 && for d in *.deb; do dpkg -x "$d" ..; done
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"
HOSTLIBS="$HOME/Android/hostlibs/usr/lib/x86_64-linux-gnu"
[ -d "$HOSTLIBS" ] && export LD_LIBRARY_PATH="$HOSTLIBS:$HOSTLIBS/pulseaudio${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
ADB="$ANDROID_HOME/platform-tools/adb"

if [ ! -w /dev/kvm ]; then
  echo "The emulator needs KVM, and /dev/kvm is not writable: sudo chmod 666 /dev/kvm" >&2
  exit 1
fi
"$ANDROID_HOME/emulator/emulator" -avd "$AVD" -no-snapshot-save -no-boot-anim -no-audio \
  -gpu swiftshader_indirect -scale "${EMULATOR_SCALE:-0.48}" >/tmp/typedblite-demo-emulator.log 2>&1 &
"$ADB" wait-for-device
until [ "$("$ADB" shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
"$ADB" reverse "tcp:$DEMO_PORT" "tcp:$DEMO_PORT"
APK="$HERE/android/app/build/outputs/apk/debug/app-debug.apk"
[ -f "$APK" ] || "$HERE/build-apk.sh" >/dev/null
"$ADB" install -r "$APK" >/dev/null
echo "Emulator booted, app installed, localhost:$DEMO_PORT forwarded into the device."
