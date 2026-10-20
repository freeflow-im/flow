package im.freeflow.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;
import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import java.util.HashMap;
import java.util.Map;

/**
 * The credential store behind `host.secrets` (docs/specs/desktop-electron.md):
 * the desktop keeps bearers in the OS store; here they live in
 * EncryptedSharedPreferences, keyed by an Android Keystore master key, so no
 * plaintext token lands on disk. When the store cannot be opened (a broken
 * keystore, a device with no lock screen support) the desktop rule applies:
 * memory-only, `available` false, the session lasts until the app quits.
 */
final class Secrets {
  private static final String TAG = "FlowSecrets";
  private static final String FILE = "flow.secrets";
  private static Secrets instance;

  private final SharedPreferences prefs; // null = memory only
  private final Map<String, String> memory = new HashMap<>();

  static synchronized Secrets get(Context context) {
    if (instance == null) instance = new Secrets(context.getApplicationContext());
    return instance;
  }

  private Secrets(Context context) {
    SharedPreferences p = null;
    try {
      MasterKey key = new MasterKey.Builder(context).setKeyScheme(MasterKey.KeyScheme.AES256_GCM).build();
      p = EncryptedSharedPreferences.create(
          context, FILE, key,
          EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
          EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    } catch (Exception e) {
      Log.w(TAG, "encrypted store unavailable; credentials are memory-only this session", e);
    }
    prefs = p;
  }

  boolean available() {
    return prefs != null;
  }

  /** Every stored value — the boot snapshot the page mirrors. */
  synchronized Map<String, String> load() {
    Map<String, String> out = new HashMap<>();
    if (prefs != null) {
      for (Map.Entry<String, ?> e : prefs.getAll().entrySet()) {
        if (e.getValue() instanceof String) out.put(e.getKey(), (String) e.getValue());
      }
    } else {
      out.putAll(memory);
    }
    return out;
  }

  synchronized void set(String key, String value) {
    if (prefs != null) prefs.edit().putString(key, value).apply();
    else memory.put(key, value);
  }

  synchronized void delete(String key) {
    if (prefs != null) prefs.edit().remove(key).apply();
    else memory.remove(key);
  }
}
