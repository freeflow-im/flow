package im.freeflow.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class DeepLinksTest {

  @Test
  public void embedsAValueAsAStringLiteralNothingCanEscape() {
    assertEquals("\"flow://signin?code=abc\"", DeepLinks.jsonString("flow://signin?code=abc"));
    assertEquals("\"a\\\"b\\\\c\\nd\"", DeepLinks.jsonString("a\"b\\c\nd"));
    assertEquals("\"\\u003c/script>\"", DeepLinks.jsonString("</script>"));
    assertEquals("\"x\\u2028y\\u0001\"", DeepLinks.jsonString("x\u2028y\u0001"));
    assertEquals("\"\"", DeepLinks.jsonString(""));
  }
}
