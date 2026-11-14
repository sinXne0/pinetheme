package studio.pinetheme.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.JsPromptResult;
import android.webkit.JsResult;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.ArrayList;
import java.util.Iterator;
import java.util.List;

/**
 * PineTheme Studio for Android.
 *
 * A thin, dependency-free WebView shell around the PineTheme Studio renderer.
 * The web app talks to the device through the `Android` JavaScript bridge:
 * SAF is used for import/export, and working themes live in the app's
 * external files directory so autosave never needs a storage permission.
 */
public class MainActivity extends Activity {

    private static final int REQ_PICK = 101;
    private static final int REQ_SAVE = 102;

    private static final String[] BINARY_EXT = {
            "png", "jpg", "jpeg", "gif", "bmp", "webp", "tiff", "tif",
            "raw", "rgb", "ttf", "otf", "woff", "woff2", "bin", "wav",
            "mp3", "ogg", "mid", "rtttl", "so", "ko", "gz", "zip", "svg"
    };

    private WebView web;
    private ValueCallback<Uri[]> pickCallback;
    private byte[] saveBytes;
    private String saveMime;

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        Window win = getWindow();
        win.setStatusBarColor(Color.parseColor("#05070a"));
        win.setNavigationBarColor(Color.parseColor("#05070a"));
        if (Build.VERSION.SDK_INT >= 29) {
            win.setNavigationBarContrastEnforced(false);
        }
        win.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#040608"));

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#040608"));
        web.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowContentAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        s.setTextZoom(100);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);

        if (Build.VERSION.SDK_INT >= 19) {
            WebView.setWebContentsDebuggingEnabled(true);
        }

        web.addJavascriptInterface(new Bridge(), "Android");

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (pickCallback != null) {
                    pickCallback.onReceiveValue(null);
                }
                pickCallback = callback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                // Honour the <input accept="..."> filter (image/*, .zip, ...).
                String type = "*/*";
                String[] accept = params == null ? null : params.getAcceptTypes();
                if (accept != null) {
                    for (String a : accept) {
                        if (a == null) continue;
                        String t = a.trim();
                        if (t.isEmpty()) continue;
                        if (t.startsWith(".")) {
                            if (t.equalsIgnoreCase(".zip")) type = "application/zip";
                            continue;
                        }
                        type = t;
                    }
                }
                intent.setType(type);
                if (params != null && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE) {
                    intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                }
                try {
                    startActivityForResult(Intent.createChooser(intent, "Select file"), REQ_PICK);
                    return true;
                } catch (Exception e) {
                    pickCallback = null;
                    toastOnUi("No file picker available");
                    return false;
                }
            }

            @Override
            public boolean onJsAlert(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsConfirm(WebView view, String url, String message, final JsResult result) {
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setPositiveButton(android.R.string.ok, (d, w) -> result.confirm())
                        .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }

            @Override
            public boolean onJsPrompt(WebView view, String url, String message, String defaultValue,
                                      final JsPromptResult result) {
                final EditText input = new EditText(MainActivity.this);
                input.setText(defaultValue == null ? "" : defaultValue);
                input.setSelection(input.getText().length());
                new AlertDialog.Builder(MainActivity.this)
                        .setMessage(message)
                        .setView(input)
                        .setPositiveButton(android.R.string.ok,
                                (d, w) -> result.confirm(input.getText().toString()))
                        .setNegativeButton(android.R.string.cancel, (d, w) -> result.cancel())
                        .setOnCancelListener(d -> result.cancel())
                        .show();
                return true;
            }
        });

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (uri == null) return false;
                String scheme = uri.getScheme();
                if (scheme == null || "file".equals(scheme) || "about".equals(scheme)
                        || "data".equals(scheme) || "blob".equals(scheme)) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // no handler installed
                }
                return true;
            }
        });

        root.addView(web);
        setContentView(root);
        // aapt2 is invoked with -A android/build/www, so the payload's files
        // land at the root of assets/.
        web.loadUrl("file:///android_asset/index.html");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK) {
            Uri[] uris = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    List<Uri> list = new ArrayList<>();
                    for (int i = 0; i < count; i++) {
                        Uri u = data.getClipData().getItemAt(i).getUri();
                        if (u != null) list.add(u);
                    }
                    if (!list.isEmpty()) uris = list.toArray(new Uri[0]);
                } else if (data.getData() != null) {
                    uris = new Uri[]{data.getData()};
                }
            }
            if (pickCallback != null) {
                pickCallback.onReceiveValue(uris);
                pickCallback = null;
            }
            return;
        }

        if (requestCode == REQ_SAVE) {
            if (resultCode == RESULT_OK && data != null && data.getData() != null && saveBytes != null) {
                try (OutputStream out = getContentResolver().openOutputStream(data.getData())) {
                    if (out != null) {
                        out.write(saveBytes);
                        out.flush();
                        toastOnUi("Saved to device");
                    }
                } catch (Exception e) {
                    toastOnUi("Save failed: " + e.getMessage());
                }
            }
            saveBytes = null;
            saveMime = null;
            return;
        }

        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public void onBackPressed() {
        if (web == null) {
            super.onBackPressed();
            return;
        }
        web.evaluateJavascript(
                "(function(){try{return window.__ptBackPressed?!!window.__ptBackPressed():false;}catch(e){return false;}})()",
                value -> {
                    if (!"true".equals(value)) {
                        finish();
                    }
                });
    }

    private void toastOnUi(final String msg) {
        runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
    }

    // ------------------------------------------------------------------
    // Storage helpers
    // ------------------------------------------------------------------

    private File storageRoot() {
        File ext = getExternalFilesDir(null);
        return ext != null ? ext : getFilesDir();
    }

    private File themesDir() {
        File dir = new File(storageRoot(), "themes");
        if (!dir.exists()) dir.mkdirs();
        return dir;
    }

    /** Resolve a theme token ("themes/foo", "foo" or an absolute path under storage). */
    private File resolveThemeDir(String token) throws Exception {
        if (token == null || token.trim().isEmpty()) {
            throw new Exception("empty path");
        }
        String t = token.trim().replace('\\', '/');
        File candidate;
        if (t.startsWith("/")) {
            candidate = new File(t);
        } else if (t.equals("themes")) {
            candidate = themesDir();
        } else if (t.startsWith("themes/")) {
            candidate = new File(storageRoot(), t);
        } else {
            candidate = new File(themesDir(), t);
        }
        File root = storageRoot().getCanonicalFile();
        File canon = candidate.getCanonicalFile();
        String rootPath = root.getPath();
        if (!canon.getPath().equals(rootPath) && !canon.getPath().startsWith(rootPath + File.separator)) {
            throw new Exception("path outside app storage");
        }
        return canon;
    }

    private static boolean isBinaryName(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0) return false;
        String ext = name.substring(dot + 1).toLowerCase();
        for (String b : BINARY_EXT) {
            if (b.equals(ext)) return true;
        }
        return false;
    }

    private static String readBase64(File file) throws Exception {
        try (InputStream in = new FileInputStream(file)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream((int) Math.max(1024, file.length()));
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP);
        }
    }

    private static void collectFiles(File dir, File root, JSONArray out) throws Exception {
        File[] entries = dir.listFiles();
        if (entries == null) return;
        for (File e : entries) {
            String name = e.getName();
            if (name.equals(".git") || name.equals(".DS_Store") || name.equals("node_modules")) continue;
            if (e.isDirectory()) {
                collectFiles(e, root, out);
            } else if (e.isFile()) {
                String rel = root.toURI().relativize(e.toURI()).getPath();
                JSONObject f = new JSONObject();
                f.put("path", rel);
                f.put("base64", readBase64(e));
                f.put("binary", isBinaryName(rel));
                out.put(f);
            }
        }
    }

    private static String mimeFor(String name) {
        String n = name == null ? "" : name.toLowerCase();
        if (n.endsWith(".zip")) return "application/zip";
        if (n.endsWith(".png")) return "image/png";
        if (n.endsWith(".jpg") || n.endsWith(".jpeg")) return "image/jpeg";
        if (n.endsWith(".gif")) return "image/gif";
        if (n.endsWith(".webp")) return "image/webp";
        if (n.endsWith(".json")) return "application/json";
        if (n.endsWith(".svg")) return "image/svg+xml";
        if (n.endsWith(".txt") || n.endsWith(".md")) return "text/plain";
        return "application/octet-stream";
    }

    // ------------------------------------------------------------------
    // JavaScript bridge
    // ------------------------------------------------------------------

    public class Bridge {

        @JavascriptInterface
        public String platform() {
            return "android";
        }

        @JavascriptInterface
        public String versionName() {
            try {
                return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
            } catch (Exception e) {
                return "0.2.0";
            }
        }

        /** Open the system "create document" dialog and write the payload there. */
        @JavascriptInterface
        public String saveBase64(final String name, final String mime, final String base64) {
            try {
                saveBytes = Base64.decode(base64, Base64.DEFAULT);
            } catch (Exception e) {
                return "error:base64";
            }
            saveMime = (mime == null || mime.isEmpty()) ? mimeFor(name) : mime;
            final String title = (name == null || name.isEmpty()) ? "pinetheme-export" : name;
            runOnUiThread(() -> {
                Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                intent.setType(saveMime);
                intent.putExtra(Intent.EXTRA_TITLE, title);
                try {
                    startActivityForResult(intent, REQ_SAVE);
                } catch (Exception e) {
                    toastOnUi("No save dialog available");
                }
            });
            return "ok";
        }

        /** Persist a theme tree under app storage. Returns the absolute folder path. */
        @JavascriptInterface
        public String writeTree(String token, String filesJson) {
            try {
                File dir = resolveThemeDir(token);
                if (!dir.exists() && !dir.mkdirs()) {
                    return "error:cannot create " + dir;
                }
                JSONArray files = new JSONArray(filesJson);
                File root = dir.getCanonicalFile();
                int written = 0;
                for (int i = 0; i < files.length(); i++) {
                    JSONObject f = files.getJSONObject(i);
                    String rel = f.getString("path");
                    File out = new File(root, rel).getCanonicalFile();
                    if (!out.getPath().startsWith(root.getPath() + File.separator)) {
                        continue;
                    }
                    File parent = out.getParentFile();
                    if (parent != null && !parent.exists()) parent.mkdirs();
                    byte[] data = Base64.decode(f.getString("base64"), Base64.DEFAULT);
                    try (FileOutputStream fos = new FileOutputStream(out)) {
                        fos.write(data);
                    }
                    written++;
                }
                return root.getAbsolutePath() + " (" + written + " files)";
            } catch (Exception e) {
                return "error:" + e.getMessage();
            }
        }

        /** Read a theme folder back into {name, files:[...]} JSON. */
        @JavascriptInterface
        public String readTree(String token) {
            try {
                File dir = resolveThemeDir(token);
                if (!dir.isDirectory()) return null;
                JSONArray files = new JSONArray();
                collectFiles(dir, dir, files);
                JSONObject tree = new JSONObject();
                tree.put("name", dir.getName());
                tree.put("files", files);
                return tree.toString();
            } catch (Exception e) {
                return null;
            }
        }

        /** List stored themes with the metadata the Theme Library cards need. */
        @JavascriptInterface
        public String listThemes() {
            JSONArray out = new JSONArray();
            File[] entries = themesDir().listFiles();
            if (entries == null) return "[]";
            for (File dir : entries) {
                if (!dir.isDirectory() || dir.getName().startsWith(".")) continue;
                JSONObject meta = readMeta(dir);
                if (meta != null) out.put(meta);
            }
            return out.toString();
        }

        @JavascriptInterface
        public void toast(String msg) {
            toastOnUi(msg == null ? "" : msg);
        }
    }

    private JSONObject readMeta(File dir) {
        try {
            File tj = new File(dir, "theme.json");
            if (!tj.isFile()) return null;
            String text = new String(readAll(tj), "UTF-8");
            JSONObject json = new JSONObject(text);

            int files = 0, components = 0, assets = 0;
            long bytes = 0;
            List<File> stack = new ArrayList<>();
            stack.add(dir);
            while (!stack.isEmpty()) {
                File d = stack.remove(stack.size() - 1);
                File[] entries = d.listFiles();
                if (entries == null) continue;
                for (File e : entries) {
                    String n = e.getName();
                    if (n.equals(".git") || n.equals(".DS_Store") || n.equals("node_modules")) continue;
                    if (e.isDirectory()) {
                        stack.add(e);
                    } else if (e.isFile()) {
                        files++;
                        bytes += e.length();
                        String rel = dir.toURI().relativize(e.toURI()).getPath();
                        if (rel.startsWith("components/") && rel.endsWith(".json")) components++;
                        if (rel.startsWith("assets/")) assets++;
                    }
                }
            }

            JSONObject meta = new JSONObject();
            meta.put("name", dir.getName());
            meta.put("path", "themes/" + dir.getName());
            String title = json.optString("theme_name", json.optString("name", dir.getName()));
            meta.put("title", title);
            meta.put("author", json.optString("author", ""));
            meta.put("version", json.optString("theme_version", ""));
            meta.put("framework", json.optString("theme_framework_version", ""));
            meta.put("components", components);
            meta.put("assets", assets);
            meta.put("files", files);
            meta.put("bytes", bytes);
            meta.put("hasThemeJson", true);

            JSONArray swatches = new JSONArray();
            JSONObject palette = json.optJSONObject("color_palette");
            if (palette != null) {
                Iterator<String> keys = palette.keys();
                int added = 0;
                while (keys.hasNext() && added < 16) {
                    JSONObject c = palette.optJSONObject(keys.next());
                    if (c == null) continue;
                    swatches.put(String.format("#%02x%02x%02x",
                            clamp(c.optInt("r", 0)),
                            clamp(c.optInt("g", 0)),
                            clamp(c.optInt("b", 0))));
                    added++;
                }
            }
            meta.put("swatches", swatches);
            return meta;
        } catch (Exception e) {
            return null;
        }
    }

    private static int clamp(int v) {
        return Math.max(0, Math.min(255, v));
    }

    private static byte[] readAll(File f) throws Exception {
        try (InputStream in = new FileInputStream(f)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream();
            byte[] buf = new byte[8192];
            int n;
            while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }
}
