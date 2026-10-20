package im.freeflow.app;

/**
 * The hardware-back contract with the page (packages/web/src/lib/hardwareBack.ts,
 * installed by hostAndroid.ts as the host seam's `back`): the activity
 * evaluates {@link #PROBE_JS} in the WebView and reads the answer. Pure so it
 * is unit-testable off-device; the WebView call itself is three lines in
 * MainActivity.
 */
final class BackBridge {
  private BackBridge() {}

  /**
   * Calls window.__flowBack() if the page installed it and reports whether the
   * page consumed the press. Wrapped so a page without the bridge (an older
   * bundle, a crashed script) answers false rather than throwing — the shell
   * then backgrounds the app, which is the safe default.
   */
  static final String PROBE_JS =
      "(function(){try{return typeof window.__flowBack==='function'&&window.__flowBack()===true;}"
          + "catch(e){return false;}})()";

  /**
   * evaluateJavascript hands back the result serialised as JSON: the string
   * {@code "true"} for a boolean true, {@code "false"}, {@code "null"} for
   * undefined, or null if evaluation failed. Only a literal true counts.
   */
  static boolean pageConsumed(String evaluateJavascriptResult) {
    return "true".equals(evaluateJavascriptResult);
  }
}
