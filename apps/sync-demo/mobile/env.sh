# Sourced by the Android scripts: where the SDK and the JDK live. Override any of these.
export ANDROID_HOME="${ANDROID_HOME:-$HOME/Android/Sdk}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
if [ -z "${JAVA_HOME:-}" ]; then
  for jdk in "$HOME"/Android/jdk/jdk-21*; do [ -x "$jdk/bin/javac" ] && export JAVA_HOME="$jdk"; done
fi
export AVD="${AVD:-typedblite-demo}"
export ANDROID_API="${ANDROID_API:-34}"
export DEMO_PORT="${DEMO_PORT:-4300}"
