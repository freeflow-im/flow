package im.freeflow.app;

import static org.junit.Assert.assertEquals;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.Test;

public class ShellBootTest {

  @Test
  public void infoIsWhatDesktopInfoCarries() {
    assertEquals(
        "{\"platform\":\"android\",\"version\":\"0.1.0\",\"profile\":null,\"defaultServerOrigin\":\"https://app.freeflow.im\"}",
        ShellBoot.infoJson("0.1.0", "https://app.freeflow.im", null));
    assertEquals(
        "{\"platform\":\"android\",\"version\":\"0.0.0\",\"profile\":\"qa\",\"defaultServerOrigin\":\"http://127.0.0.1:8787\"}",
        ShellBoot.infoJson(null, "http://127.0.0.1:8787", "qa"));
  }

  @Test
  public void theBootScriptIsOneAssignmentThePageReadsOnce() {
    Map<String, String> secrets = new LinkedHashMap<>();
    secrets.put("flow.token", "t1");
    secrets.put("flow.cred.abc", "t2");
    String script = ShellBoot.script("{\"platform\":\"android\"}", secrets, true, "flow://signin?code=k");
    assertEquals(
        "window.flowShellBoot={info:{\"platform\":\"android\"},secrets:{\"flow.token\":\"t1\",\"flow.cred.abc\":\"t2\"},"
            + "secretsAvailable:true,launchUrl:\"flow://signin?code=k\"};",
        script);
  }

  @Test
  public void noSecretsAndNoLaunchLinkIsStillValidScript() {
    assertEquals(
        "window.flowShellBoot={info:{},secrets:{},secretsAvailable:false,launchUrl:null};",
        ShellBoot.script("{}", Collections.emptyMap(), false, null));
  }

  @Test
  public void aSecretValueCannotEscapeIntoCode() {
    Map<String, String> secrets = Collections.singletonMap("k", "\"};alert(1);</script>");
    assertEquals(
        "window.flowShellBoot={info:{},secrets:{\"k\":\"\\\"};alert(1);\\u003c/script>\"},secretsAvailable:true,launchUrl:null};",
        ShellBoot.script("{}", secrets, true, null));
  }
}
