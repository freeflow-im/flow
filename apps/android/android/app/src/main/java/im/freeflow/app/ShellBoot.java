package im.freeflow.app;

import android.webkit.WebView;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;
import java.util.Collections;
import java.util.Map;

/**
 * The Android half of the host seam's boot (docs/specs/desktop-electron.md,
 * "Bridge contract"; docs/design/ANDROID.md). The Electron shell's preload
 * hands the page its info and a decrypted snapshot of the credentials
 * synchronously, before any app script runs, so the web client's token reads
 * stay synchronous. A WebView has no preload; the nearest thing is a
 * document-start script, registered for the app's own origin only — a
 * mini-app iframe from anywhere else never sees it. The page's adapter
 * (packages/web/src/lib/hostAndroid.ts) reads `window.flowShellBoot` once and
 * builds the same bridge shape the desktop exposes as `window.flowDesktop`;
 * everything after boot goes through the FlowShell plugin.
 *
 * The snapshot is taken when the activity is created, which is also when the
 * page loads; writes after that update the store and the page's own mirror,
 * so the two never disagree while the page is up.
 */
final class ShellBoot {
  private ShellBoot() {}

  /** The page's origin inside the shell: what the server admits as a bundled
   * client (ANDROID_ORIGIN in @flow/shared) — `hostname` in capacitor.config.ts. */
  static final String ORIGIN = "https://flow.localhost";

  /** The `info` block of the bridge: what DesktopInfo carries. */
  static String infoJson(String version, String defaultServerOrigin, String profile) {
    return "{\"platform\":\"android\",\"version\":" + DeepLinks.jsonString(version == null ? "0.0.0" : version)
        + ",\"profile\":" + (profile == null || profile.isEmpty() ? "null" : DeepLinks.jsonString(profile))
        + ",\"defaultServerOrigin\":" + DeepLinks.jsonString(defaultServerOrigin) + "}";
  }

  /** The one statement the page runs before its own scripts. */
  static String script(String infoJson, Map<String, String> secrets, boolean secretsAvailable, String launchUrl) {
    StringBuilder s = new StringBuilder("window.flowShellBoot={info:").append(infoJson).append(",secrets:{");
    int n = 0;
    for (Map.Entry<String, String> e : secrets.entrySet()) {
      if (e.getKey() == null || e.getValue() == null) continue;
      if (n++ > 0) s.append(',');
      s.append(DeepLinks.jsonString(e.getKey())).append(':').append(DeepLinks.jsonString(e.getValue()));
    }
    s.append("},secretsAvailable:").append(secretsAvailable ? "true" : "false");
    s.append(",launchUrl:").append(launchUrl == null ? "null" : DeepLinks.jsonString(launchUrl));
    return s.append("};").toString();
  }

  /**
   * Register the boot script for the app's origin. Returns false when this
   * WebView cannot run document-start scripts (a very old WebView); the page
   * then boots as a plain browser tab — usable, but credentials only last the
   * session and there is no deep-link delivery until the WebView updates.
   */
  static boolean install(WebView webView, String script) {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) return false;
    WebViewCompat.addDocumentStartJavaScript(webView, script, Collections.singleton(ORIGIN));
    return true;
  }
}
