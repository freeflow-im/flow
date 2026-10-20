package im.freeflow.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** The back-button contract, from the shell's side (see BackBridge). */
public class BackBridgeTest {

  @Test
  public void onlyALiteralTrueMeansThePageConsumedThePress() {
    assertTrue(BackBridge.pageConsumed("true"));
    assertFalse(BackBridge.pageConsumed("false"));
    assertFalse(BackBridge.pageConsumed("null")); // undefined: no bridge installed
    assertFalse(BackBridge.pageConsumed("\"true\"")); // a string, not a boolean
    assertFalse(BackBridge.pageConsumed(""));
    assertFalse(BackBridge.pageConsumed(null)); // evaluation failed
  }

  @Test
  public void probeCallsTheBridgeThePageInstallsAndNeverThrows() {
    assertTrue(BackBridge.PROBE_JS.contains("window.__flowBack"));
    assertTrue(BackBridge.PROBE_JS.contains("typeof window.__flowBack==='function'"));
    assertTrue(BackBridge.PROBE_JS.contains("catch(e){return false;}"));
    // It is an expression the WebView evaluates for a value, not a statement.
    assertEquals('(', BackBridge.PROBE_JS.charAt(0));
    assertTrue(BackBridge.PROBE_JS.endsWith("})()"));
  }
}
