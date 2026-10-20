package im.freeflow.app;

import java.util.Locale;

/**
 * Which links the shell acts on, the same two rules the desktop shell keeps
 * in apps/desktop/src/main/lib/argv.ts: only the app's own scheme is a deep
 * link, and only http(s) and mailto may be handed to the system. Pure, so it
 * is unit-tested.
 */
final class LinkPolicy {
  private LinkPolicy() {}

  /** A `flow://…` link — what the intent filter registers and the page's
   * deep-link dispatcher (packages/web/src/lib/deepLinks.ts) understands. */
  static boolean isFlowLink(String value) {
    if (value == null) return false;
    String v = value.trim();
    if (v.length() < 8 || !v.substring(0, 7).toLowerCase(Locale.ROOT).equals("flow://")) return false;
    char c = v.charAt(7);
    return (Character.isLetterOrDigit(c) || c == '.' || c == '_' || c == '-') && !v.matches(".*\\s.*");
  }

  /** External links the shell hands to the system browser or mail app.
   * Everything else — `file:`, `javascript:`, `intent:`, a custom scheme —
   * is refused; the page never gets to launch arbitrary intents. */
  static boolean isOpenableExternally(String value) {
    if (value == null) return false;
    String lower = value.trim().toLowerCase(Locale.ROOT);
    return lower.startsWith("https://") || lower.startsWith("http://") || lower.startsWith("mailto:");
  }
}
