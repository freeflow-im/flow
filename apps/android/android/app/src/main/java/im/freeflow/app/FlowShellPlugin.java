package im.freeflow.app;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import androidx.browser.customtabs.CustomTabsIntent;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.Locale;

/**
 * The write half of the host seam (docs/specs/desktop-electron.md, "Bridge
 * contract"): what the page asks the shell to do after boot. The read half —
 * info and the credential snapshot — went in at document start (ShellBoot),
 * so nothing here needs to be synchronous. The page's adapter
 * (packages/web/src/lib/hostAndroid.ts) turns these into the same
 * FlowDesktopBridge shape the Electron preload exposes.
 */
@CapacitorPlugin(name = "FlowShell")
public class FlowShellPlugin extends Plugin {

  /** `flow://…` links the OS handed the app: retained until the page's
   * listener is up, so a cold-start link is never lost. */
  static final String EVENT_DEEP_LINK = "deepLink";

  @Override
  public void load() {
    // The intent the activity was created with — a launcher tap has no data.
    deliver(getActivity() == null ? null : getActivity().getIntent());
  }

  /** singleTask: a link while the app is alive arrives here, not in load(). */
  @Override
  protected void handleOnNewIntent(Intent intent) {
    super.handleOnNewIntent(intent);
    deliver(intent);
  }

  private void deliver(Intent intent) {
    Uri data = intent == null ? null : intent.getData();
    if (data == null || !LinkPolicy.isFlowLink(data.toString())) return;
    JSObject payload = new JSObject();
    payload.put("url", data.toString());
    notifyListeners(EVENT_DEEP_LINK, payload, true);
  }

  // -- secrets -----------------------------------------------------------

  @PluginMethod
  public void secretSet(PluginCall call) {
    String key = call.getString("key");
    String value = call.getString("value");
    if (key == null || key.isEmpty() || value == null) {
      call.reject("key and value are required");
      return;
    }
    Secrets.get(getContext()).set(key, value);
    call.resolve();
  }

  @PluginMethod
  public void secretDelete(PluginCall call) {
    String key = call.getString("key");
    if (key == null || key.isEmpty()) {
      call.reject("key is required");
      return;
    }
    Secrets.get(getContext()).delete(key);
    call.resolve();
  }

  // -- links -------------------------------------------------------------

  /**
   * The system browser, as a Chrome Custom Tab when one is available: Google
   * sign-in, another server's sign-in and Slack consent all go out this way
   * and come back as a `flow://` link. Only http(s) and mailto (LinkPolicy).
   */
  @PluginMethod
  public void openExternal(PluginCall call) {
    String url = call.getString("url");
    if (!LinkPolicy.isOpenableExternally(url)) {
      call.reject("only http(s) and mailto links open externally");
      return;
    }
    Uri uri = Uri.parse(url.trim());
    try {
      if (uri.getScheme() != null && uri.getScheme().toLowerCase(Locale.ROOT).equals("mailto")) {
        Intent mail = new Intent(Intent.ACTION_VIEW, uri).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(mail);
      } else {
        new CustomTabsIntent.Builder().build().launchUrl(getContext(), uri);
      }
      call.resolve();
    } catch (ActivityNotFoundException e) {
      call.reject("nothing on this device opens " + uri.getScheme() + " links");
    }
  }
}
