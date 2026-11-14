#!/usr/bin/env bash
#
# Fetch a root-free Android toolchain (Temurin JDK 17 + Android command-line
# tools + platform 34 + build-tools 34.0.0) into ~/.local/share/pinetheme-android.
#
set -euo pipefail

ROOT="$HOME/.local/share/pinetheme-android"
DL="$ROOT/dl"
SDK="$ROOT/android-sdk"
JDK="$ROOT/jdk"
mkdir -p "$DL" "$SDK"

log() { echo "[toolchain] $*"; }

if [ ! -x "$JDK/bin/javac" ]; then
  log "downloading Temurin JDK 17"
  curl -fL --retry 3 -o "$DL/jdk17.tar.gz" \
    "https://api.adoptium.net/v3/binary/latest/17/ga/linux/x64/jdk/hotspot/normal/eclipse"
  rm -rf "$JDK"
  mkdir -p "$JDK"
  tar -xzf "$DL/jdk17.tar.gz" -C "$JDK" --strip-components=1
fi
export JAVA_HOME="$JDK"
export PATH="$JDK/bin:$PATH"
log "java: $(java -version 2>&1 | head -1)"

if [ ! -x "$SDK/cmdline-tools/latest/bin/sdkmanager" ]; then
  log "downloading Android command-line tools"
  curl -fL --retry 3 -o "$DL/cmdline-tools.zip" \
    "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip"
  rm -rf "$SDK/cmdline-tools"
  mkdir -p "$SDK/cmdline-tools"
  unzip -q -o "$DL/cmdline-tools.zip" -d "$SDK/cmdline-tools"
  mv "$SDK/cmdline-tools/cmdline-tools" "$SDK/cmdline-tools/latest"
fi

export ANDROID_HOME="$SDK"
export ANDROID_SDK_ROOT="$SDK"

log "accepting SDK licenses"
yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" --licenses >/dev/null 2>&1 || true

log "installing platform-tools, platform 34 and build-tools 34.0.0"
yes | "$SDK/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$SDK" \
  "platform-tools" "platforms;android-34" "build-tools;34.0.0" >/dev/null

log "ready"
echo "ANDROID_HOME=$SDK"
echo "JAVA_HOME=$JDK"
