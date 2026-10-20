package im.freeflow.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class LinkPolicyTest {

  @Test
  public void onlyTheAppsOwnSchemeIsADeepLink() {
    assertTrue(LinkPolicy.isFlowLink("flow://signin?code=abc"));
    assertTrue(LinkPolicy.isFlowLink("FLOW://invite/tok"));
    assertTrue(LinkPolicy.isFlowLink("flow://slack/connected?operationId=1"));
    assertFalse(LinkPolicy.isFlowLink("https://app.freeflow.im/join/acme/tok"));
    assertFalse(LinkPolicy.isFlowLink("flow://"));
    assertFalse(LinkPolicy.isFlowLink("flow:// signin"));
    assertFalse(LinkPolicy.isFlowLink("flow://sign in"));
    assertFalse(LinkPolicy.isFlowLink(""));
    assertFalse(LinkPolicy.isFlowLink(null));
  }

  @Test
  public void onlyWebAndMailLinksOpenExternally() {
    assertTrue(LinkPolicy.isOpenableExternally("https://accounts.google.com/x"));
    assertTrue(LinkPolicy.isOpenableExternally("http://127.0.0.1:8787/?native=google"));
    assertTrue(LinkPolicy.isOpenableExternally("mailto:someone@example.com"));
    assertTrue(LinkPolicy.isOpenableExternally("  HTTPS://Example.com "));
    assertFalse(LinkPolicy.isOpenableExternally("javascript:alert(1)"));
    assertFalse(LinkPolicy.isOpenableExternally("file:///etc/passwd"));
    assertFalse(LinkPolicy.isOpenableExternally("intent://scan/#Intent;scheme=zxing;end"));
    assertFalse(LinkPolicy.isOpenableExternally("flow://signin?code=x"));
    assertFalse(LinkPolicy.isOpenableExternally(""));
    assertFalse(LinkPolicy.isOpenableExternally(null));
  }
}
