package im.freeflow.app;

import java.util.Locale;

/** String literals for the scripts the shell hands the page (ShellBoot). */
final class DeepLinks {
  private DeepLinks() {}

  /** A JSON/JS string literal: quotes, backslashes, control characters, the
   * two line separators JS treats as newlines, and '<' (so "</script>" can
   * never appear) are escaped. */
  static String jsonString(String s) {
    StringBuilder sb = new StringBuilder(s.length() + 2).append('"');
    for (int i = 0; i < s.length(); i++) {
      char c = s.charAt(i);
      switch (c) {
        case '"': sb.append("\\\""); break;
        case '\\': sb.append("\\\\"); break;
        case '\n': sb.append("\\n"); break;
        case '\r': sb.append("\\r"); break;
        case '\t': sb.append("\\t"); break;
        case '<': sb.append("\\u003c"); break;
        case ' ': sb.append("\\u2028"); break;
        case ' ': sb.append("\\u2029"); break;
        default:
          if (c < 0x20) sb.append(String.format(Locale.ROOT, "\\u%04x", (int) c));
          else sb.append(c);
      }
    }
    return sb.append('"').toString();
  }
}
