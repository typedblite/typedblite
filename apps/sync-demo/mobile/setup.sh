#!/usr/bin/env bash
# One-time setup for the Android device: a JDK 21, the Android SDK, platform 35 (Capacitor 7 compiles
# against it), an emulator image, the AVD, and the Capacitor native project. Idempotent.
#
# The emulator needs KVM:  sudo chmod 666 /dev/kvm   (until the next reboot or WSL restart), or
#                          sudo usermod -aG kvm "$USER"   and log in again.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
source "$HERE/env.sh"

# JDK 21 (Gradle needs javac; a JRE is not enough).
if [ -z "${JAVA_HOME:-}" ] || [ ! -x "$JAVA_HOME/bin/javac" ]; then
  mkdir -p "$HOME/Android/jdk"
  curl -fsSL "https://api.adoptium.net/v3/binary/latest/21/ga/linux/x64/jdk/hotspot/normal/eclipse" | tar -xz -C "$HOME/Android/jdk"
  source "$HERE/env.sh"
fi

# The SDK's command-line tools.
if [ ! -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]; then
  tmp="$(mktemp -d)"
  curl -fsSL -o "$tmp/tools.zip" https://dl.google.com/android/repository/commandlinetools-linux-13114758_latest.zip
  unzip -q "$tmp/tools.zip" -d "$tmp"
  mkdir -p "$ANDROID_HOME/cmdline-tools"
  rm -rf "$ANDROID_HOME/cmdline-tools/latest"
  mv "$tmp/cmdline-tools" "$ANDROID_HOME/cmdline-tools/latest"
  rm -rf "$tmp"
fi

SM="$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"
IMAGE="system-images;android-${ANDROID_API};google_apis;x86_64"
yes | "$SM" --licenses >/dev/null || true
# API 34 by default for the emulator: the API 35 x86_64 image has failed to download here
# ("unknown archive"), and that failure aborts the whole sdkmanager call.
"$SM" --install "platform-tools" "emulator" "platforms;android-35" "build-tools;35.0.0" "$IMAGE"

if ! "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" list avd -c | grep -qx "$AVD"; then
  echo no | "$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" create avd -n "$AVD" -k "$IMAGE" -d pixel_7
fi

# The Capacitor native project, generated from capacitor.config.json.
cd "$HERE"
[ -d android ] || npx cap add android
npx cap sync android
echo "Android ready: SDK at $ANDROID_HOME, JDK at $JAVA_HOME, AVD $AVD."
