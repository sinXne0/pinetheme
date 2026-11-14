#!/usr/bin/env bash
#
# Build the PineTheme Studio Android APK without Gradle: aapt2 + javac + d8 +
# zipalign + apksigner, all straight from the Android SDK build-tools.
#
#   ANDROID_HOME  Android SDK root      (default ~/.local/share/pinetheme-android/android-sdk)
#   JAVA_HOME     JDK 17 root           (default ~/.local/share/pinetheme-android/jdk)
#
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/.." && pwd)"

SDK="${ANDROID_HOME:-$HOME/.local/share/pinetheme-android/android-sdk}"
JDK="${JAVA_HOME:-$HOME/.local/share/pinetheme-android/jdk}"
BT="$SDK/build-tools/34.0.0"
PLATFORM="$SDK/platforms/android-34/android.jar"

BUILD="$HERE/build"
DIST="$HERE/dist"
VERSION="$(node -p "require('$REPO/package.json').version" 2>/dev/null || echo 0.2.0)"
APK_NAME="PineTheme-Studio-${VERSION}-android.apk"

need() {
  [ -e "$1" ] || { echo "missing: $1" >&2; echo "run android/tools/install-toolchain.sh first" >&2; exit 1; }
}

command -v node >/dev/null || { echo "node is required" >&2; exit 1; }
need "$JDK/bin/javac"
need "$JDK/bin/keytool"
need "$BT/aapt2"
need "$BT/d8"
need "$BT/zipalign"
need "$BT/apksigner"
need "$PLATFORM"

export JAVA_HOME="$JDK"
export PATH="$JDK/bin:$PATH"

rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$DIST"

echo "[1/7] assembling web payload"
node "$HERE/tools/build-web.js"

echo "[2/7] compiling resources"
"$BT/aapt2" compile --dir "$HERE/app/res" -o "$BUILD/res.zip"

echo "[3/7] linking resources + assets"
"$BT/aapt2" link \
  -o "$BUILD/base.apk" \
  -I "$PLATFORM" \
  --manifest "$HERE/app/AndroidManifest.xml" \
  -A "$BUILD/www" \
  --java "$BUILD/gen" \
  --min-sdk-version 24 \
  --target-sdk-version 34 \
  --version-code 1 \
  --version-name "$VERSION" \
  "$BUILD/res.zip"

echo "[4/7] compiling java"
find "$HERE/app/src" -name '*.java' > "$BUILD/sources.txt"
"$JDK/bin/javac" --release 8 -classpath "$PLATFORM" \
  -d "$BUILD/classes" @"$BUILD/sources.txt"

echo "[5/7] dexing"
# shellcheck disable=SC2046
"$BT/d8" --release --min-api 24 --lib "$PLATFORM" \
  --output "$BUILD/dex" $(find "$BUILD/classes" -name '*.class' | sort)

echo "[6/7] packaging"
cp "$BUILD/base.apk" "$BUILD/unsigned.apk"
python3 - "$BUILD/unsigned.apk" "$BUILD/dex/classes.dex" <<'PY'
import sys, zipfile
apk, dex = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk, 'a', zipfile.ZIP_DEFLATED) as z:
    z.write(dex, 'classes.dex')
PY
"$BT/zipalign" -f -p 4 "$BUILD/unsigned.apk" "$BUILD/aligned.apk"

KEYSTORE="$HERE/keystore/debug.keystore"
if [ ! -f "$KEYSTORE" ]; then
  echo "      creating debug keystore"
  mkdir -p "$(dirname "$KEYSTORE")"
  "$JDK/bin/keytool" -genkeypair -v \
    -keystore "$KEYSTORE" \
    -storepass android -keypass android \
    -alias androiddebugkey \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -dname "CN=Android Debug,O=Android,C=US" >/dev/null 2>&1
fi

echo "[7/7] signing"
"$BT/apksigner" sign \
  --ks "$KEYSTORE" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --ks-key-alias androiddebugkey \
  --out "$DIST/$APK_NAME" \
  "$BUILD/aligned.apk"

"$BT/apksigner" verify --print-certs "$DIST/$APK_NAME" | head -4

SIZE="$(du -h "$DIST/$APK_NAME" | cut -f1)"
echo
echo "APK: $DIST/$APK_NAME ($SIZE)"
