package im.freeflow.app;

import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import com.getcapacitor.BridgeActivity;

/**
 * The shell around packages/web (docs/design/ANDROID.md). It is kept thin on
 * purpose: the page owns everything the web client owns on the desktop, and
 * reaches the shell only through the host seam — a document-start script for
 * boot (ShellBoot) and the FlowShell plugin after that. There is no
 * Android-only UI code.
 */
public class MainActivity extends BridgeActivity {

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    // Before super.onCreate: that is where the bridge is built and the page
    // loaded, and a plugin registered later is invisible to it.
    registerPlugin(FlowShellPlugin.class);
    super.onCreate(savedInstanceState);
    installBackHandling();
  }

  /**
   * Hardware back: ask the page first (window.__flowBack — an overlay, the
   * thread, the side panel, the drawer), and only when it has nothing to
   * close send the app to the background, the way every chat app does. Never
   * finish(): the next tap on the launcher should land where the user left
   * off, socket and all. Registered after super.onCreate so it sits above
   * Capacitor's own callback in the dispatcher and takes precedence.
   */
  private void installBackHandling() {
    getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
      @Override
      public void handleOnBackPressed() {
        WebView webView = getBridge() == null ? null : getBridge().getWebView();
        if (webView == null) {
          moveTaskToBack(true);
          return;
        }
        webView.evaluateJavascript(BackBridge.PROBE_JS, result -> {
          if (!BackBridge.pageConsumed(result)) moveTaskToBack(true);
        });
      }
    });
  }

  /**
   * Capacitor inflates the WebView in super.onCreate and loads the page in
   * load(); in between is the one place a document-start script can be
   * registered before the first navigation, which is what makes the page's
   * credential reads synchronous (ShellBoot).
   */
  @Override
  protected void load() {
    WebView webView = findViewById(com.getcapacitor.android.R.id.webview);
    if (webView != null) {
      Secrets secrets = Secrets.get(this);
      Uri data = getIntent() == null ? null : getIntent().getData();
      String launchUrl = data != null && LinkPolicy.isFlowLink(data.toString()) ? data.toString() : null;
      String info = ShellBoot.infoJson(BuildConfig.VERSION_NAME, BuildConfig.FLOW_SERVER_URL, null);
      ShellBoot.install(webView, ShellBoot.script(info, secrets.load(), secrets.available(), launchUrl));
    }
    super.load();
  }

  /** singleTask: the bridge forwards this to every plugin (FlowShellPlugin.handleOnNewIntent). */
  @Override
  protected void onNewIntent(Intent intent) {
    super.onNewIntent(intent);
    setIntent(intent);
  }
}
