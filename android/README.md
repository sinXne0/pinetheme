# PineTheme Studio for Android

A native Android build of [PineTheme Studio](../README.md), packaged as a
single WebView shell so the whole studio — preview, layers, Image Lab, palette
tools, validators, ZIP engine — runs offline on a phone or tablet.

The app is **dependency-free**: no Gradle, no AndroidX, no Capacitor. It is a
plain `Activity` plus the studio's existing web assets, compiled straight from
the Android SDK build tools. That keeps the APK at ~1.1 MB and makes the build
reproducible with nothing but a JDK and the SDK.

- **Package:** `studio.pinetheme.app`
- **Version:** matches `package.json` (currently `0.2.0`)
- **Min SDK:** 24 (Android 7.0) · **Target SDK:** 34
- **ABIs:** none — there is no native code, so the APK is universal
- **Permissions:** none (no storage, no network, no location)

## Install

```bash
adb install -r android/dist/PineTheme-Studio-0.2.0-android.apk
```

Or copy the APK to the device and tap it, allowing “install unknown apps” for
the file manager when prompted. The APK is signed with a locally generated
debug key, so Android will warn that the app is from an unknown developer.

## Build

A root-free toolchain (Temurin JDK 17 + Android command-line tools + platform
34 + build-tools 34.0.0) can be installed under
`~/.local/share/pinetheme-android` without touching the system:

```bash
bash android/tools/install-toolchain.sh
bash android/build.sh
```

`android/build.sh` is the whole build:

1. `node android/tools/build-web.js` assembles `android/build/www` — copies
   `src/`, injects the mobile layer, and converts the bundled reference theme
   into `reference/wargames-tree.json` (the same tree the Electron preload
   reads from disk).
2. `aapt2 compile` / `aapt2 link` build and link resources; `-A` puts the web
   payload at the root of `assets/`.
3. `javac --release 8` compiles the shell, `d8` dexes it.
4. `classes.dex` is appended, `zipalign` aligns, `apksigner` signs.

Override `ANDROID_HOME` / `JAVA_HOME` to use an existing SDK/JDK instead of the
local one. The output is `android/dist/PineTheme-Studio-<version>-android.apk`.

A debug keystore is generated on first build at `android/keystore/debug.keystore`
(password `android`, alias `androiddebugkey`). For a release build, sign with
your own key:

```bash
~/.local/share/pinetheme-android/android-sdk/build-tools/34.0.0/apksigner sign \
  --ks my-release.keystore --out pinetheme-release.apk \
  android/build/aligned.apk
```

## How it works

```
android/
  app/                 AndroidManifest, resources, launcher icons
    src/studio/pinetheme/app/MainActivity.java
  mobile/              the mobile layer, injected at build time only
    bridge.js          window.api implementation + phone chrome
    mobile.css         all layout overrides, scoped to body.pt-mobile
  tools/
    build-web.js       assembles build/www and patches index.html
    install-toolchain.sh
    smoke-test.js      headless functional test
    device-test.js     mobile-emulation + touch test
    layout-probe.js    geometry/overflow measurements
  build.sh
```

### One renderer, two shells

`main.js`/`preload.js` (Electron) are untouched. The Android shell loads
`file:///android_asset/index.html`, and `bridge.js` installs a `window.api`
object with the same methods as `preload.js` (`loadReferenceTree`,
`openZip`, `saveZip`, `saveThemeToFolder`, `pickAssetFiles`, `scanThemeRepo`,
…). Because `window.api` exists, the renderer takes its Electron code paths
unchanged — no forks of `app.js`, `preview.js` or `model.js`.

The only renderer change is touch support for canvas editing
(`touchstart`/`touchmove`/`touchend` alongside the existing mouse listeners)
and one guard that keeps the mobile build at “fit” zoom instead of jumping to
1:1 when Edit mode is enabled.

### Files on the device

Android's storage-access framework replaces folder browsing:

| Action | Desktop | Android |
| --- | --- | --- |
| Open a theme | folder picker | **ZIP** toolbar button → system file picker |
| Save project | folder picker | writes to app storage, no prompt |
| Export theme | folder picker | **Export** → “create document” dialog |
| Theme library | scan a local clone | scans the app's stored themes |
| Import images | file picker | system picker, same Image Lab pipeline |

Working themes live in the app's external files directory:

```
/sdcard/Android/data/studio.pinetheme.app/files/themes/<theme-name>/
```

Saving inside the app (`Save` / `Save as…`) writes there, and the **Themes**
tab lists what it finds. ZIP import/export is the interchange format: pull a
theme off the phone as a ZIP, or push one from the desktop build. Uninstalling
the app removes its stored themes, so export anything you want to keep.

### Phone layout

`mobile.css` is entirely scoped to `body.pt-mobile`, so it cannot affect the
desktop build:

- the sidebar becomes a bottom tab bar; the preview becomes a collapsible
  56vh sheet with a compact control strip;
- Layers/Properties dock panes stay under the canvas at 28% height;
- landscape turns the tab bar into a 64px rail and widens the preview;
- forms go single-column, touch targets grow to 30–32px;
- `Open` is hidden (Android has no folder picker) and the preview zoom strip
  is hidden — Fit/1:1/2× remain in the preview header.

Editing works by touch: toggle **Edit** in the preview, then drag a layer or
item with one finger; snapping follows the **Snap 5** checkbox. The hardware
back button dismisses dialogs, clears selection, returns to the Overview tab,
and exits only when there is nothing left to close.

## Tests

The APK cannot be launched on this machine (no emulator/device), so the web
layer is validated in headless Chromium at real phone metrics:

```bash
node android/tools/smoke-test.js    # boots the app with a stubbed Android bridge
node android/tools/device-test.js   # 390x844 @2.625 touch emulation via CDP
node android/tools/layout-probe.js  # geometry + overflow report, several sizes
```

`smoke-test.js` checks the reference theme loads, ZIP round-trips through the
real engine, the native save calls fire, the library scan renders, tabs switch,
and the preview collapses. `device-test.js` drives the DevTools Protocol:

- no page-level overflow at 390×844, 360×640 and 844×390
- bottom tab bar on-screen, preview canvas large enough to edit
- real touch drag moves a layer, marks the theme dirty, and clears drag state
- the mouse drag path (as used by the Electron tests) still works
- every tab panel opens with no console errors
- `Save` writes to app storage and clears the dirty flag
- the advanced TUI image editor loads inside its sandboxed iframe
- hardware-back returns to Overview, then exits

Both use the Chromium that Playwright caches at
`~/.cache/ms-playwright/chromium-1248`; set `CHROME` or edit the constant if
yours lives elsewhere. Screenshots from the device test are written to
`/tmp/opencode/pt-device-{portrait,landscape}.png`.

To test the desktop suite after changing shared renderer code, run `npm test`
in the repository root — the touch handlers are additive, so the existing
Electron tests are unaffected.

## Limitations

- No on-device camera/gallery integration beyond the system file picker.
- Only ZIP import; there is no “open with” intent filter for `.zip` yet.
- The vendored TUI image editor is heavy; on low-end phones it is usable but
  not instant.
- Debug-signed, so it is not distributable via Google Play as-is.
- Remote debugging is enabled (`chrome://inspect` on a connected desktop) for
  development builds.

## Troubleshooting

- **Blank screen on launch:** confirm `android/build/www/index.html` exists and
  was packaged at `assets/index.html` (`unzip -l` the APK). The activity loads
  `file:///android_asset/index.html`.
- **Reference theme fails to load:** `assets/reference/wargames-tree.json`
  must exist; `build-web.js` regenerates it from `reference/wargames/`.
- **File picker does nothing:** install a document provider (most ROMs ship
  one); the app uses `ACTION_GET_CONTENT` / `ACTION_CREATE_DOCUMENT`.
- **Logs:** `adb logcat | grep -i pinetheme` or `adb shell am start -n
  studio.pinetheme.app/.MainActivity`.
