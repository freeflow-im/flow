/**
 * Server-side @-mention expansion for API-posted messages (issue #415).
 *
 * The composer resolves names to `<@userId>` tokens before it posts; anything
 * posted straight at the HTTP API (the Scheduler mini app, an agent, a bot)
 * had no way to do that, so `@Prism` stayed inert plain text and never
 * triggered the agent or a notification. This rewrites those names into the
 * same canonical token *before* the message is stored, so every downstream
 * path (notifications, app_mention events, rendering) sees a composer-typed
 * mention and nothing has to be duplicated.
 *
 * Pure: the caller supplies the workspace's members. Rules — longest display
 * name wins (`@Scott Persinger` is one mention, not `@Scott` + text),
 * case-insensitive, and anything unknown or ambiguous is left exactly as
 * typed. Never guess: a wrong expansion pings the wrong person.
 */

export interface MentionCandidate {
  id: string;
  displayName: string;
}

export interface MentionExpansion {
  /** The body with every resolved `@Name` rewritten to `<@userId>`. */
  text: string;
  /** Distinct user ids the expansion introduced, in first-seen order. */
  userIds: string[];
}

/** `@` only starts a mention at a word boundary — keeps emails (a@b.com) inert. */
function isNameChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/** Length of the backtick run starting at `i` (0 when there isn't one). */
function backtickRun(text: string, i: number): number {
  let n = 0;
  while (text[i + n] === '`') n += 1;
  return n;
}

/**
 * A fenced block opens on a line whose first non-space content is ``` (or
 * more) and closes on the next line with a run at least as long. Returns the
 * index just past the block, or the end of the text for an unclosed fence.
 */
function skipFence(text: string, start: number, fenceLen: number): number {
  let i = text.indexOf('\n', start);
  if (i === -1) return text.length;
  while (i < text.length) {
    const lineStart = i + 1;
    let j = lineStart;
    while (text[j] === ' ') j += 1;
    const run = backtickRun(text, j);
    if (run >= fenceLen) {
      const eol = text.indexOf('\n', j);
      return eol === -1 ? text.length : eol + 1;
    }
    const next = text.indexOf('\n', lineStart);
    if (next === -1) return text.length;
    i = next;
  }
  return text.length;
}

/** True when `i` is the start of a line (ignoring leading spaces). */
function atLineStart(text: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && text[j] === ' ') j -= 1;
  return j < 0 || text[j] === '\n';
}

export function expandMentions(text: string, members: MentionCandidate[]): MentionExpansion {
  const candidates = members
    .filter((m) => m.displayName.trim().length > 0)
    .map((m) => ({ id: m.id, lower: m.displayName.toLowerCase() }));
  if (candidates.length === 0) return { text, userIds: [] };
  const longest = candidates.reduce((n, c) => Math.max(n, c.lower.length), 0);

  const lower = text.toLowerCase();
  const out: string[] = [];
  const userIds: string[] = [];
  let i = 0;

  while (i < text.length) {
    const ch = text[i]!;

    if (ch === '`') {
      const run = backtickRun(text, i);
      if (run >= 3 && atLineStart(text, i)) {
        // fenced code block — copied through untouched
        const end = skipFence(text, i, run);
        out.push(text.slice(i, end));
        i = end;
        continue;
      }
      // inline code span: closes on the next run of exactly the same length
      let j = i + run;
      let close = -1;
      while (j < text.length) {
        if (text[j] === '`') {
          const r = backtickRun(text, j);
          if (r === run) {
            close = j + r;
            break;
          }
          j += r;
          continue;
        }
        j += 1;
      }
      if (close === -1) {
        // unterminated — the backticks are ordinary text, keep scanning after them
        out.push(text.slice(i, i + run));
        i += run;
        continue;
      }
      out.push(text.slice(i, close));
      i = close;
      continue;
    }

    // an existing `<@userId>` (or `<!here>`) token passes through untouched
    if (ch === '<') {
      const close = text.indexOf('>', i);
      if (close !== -1 && !/[\s<]/.test(text.slice(i + 1, close))) {
        out.push(text.slice(i, close + 1));
        i = close + 1;
        continue;
      }
    }

    if (ch !== '@' || isNameChar(text[i - 1])) {
      out.push(ch);
      i += 1;
      continue;
    }

    // greedy: the longest display name matching here wins
    const window = lower.slice(i + 1, i + 1 + longest);
    let bestLen = 0;
    let bestIds: string[] = [];
    for (const c of candidates) {
      if (c.lower.length < bestLen) continue;
      if (!window.startsWith(c.lower)) continue;
      if (isNameChar(text[i + 1 + c.lower.length])) continue; // must end on a boundary
      if (c.lower.length > bestLen) {
        bestLen = c.lower.length;
        bestIds = [c.id];
      } else if (!bestIds.includes(c.id)) {
        bestIds.push(c.id);
      }
    }

    // no match, or two different members answering to the same name → literal
    if (bestIds.length !== 1) {
      out.push(ch);
      i += 1;
      continue;
    }
    const id = bestIds[0]!;
    out.push(`<@${id}>`);
    if (!userIds.includes(id)) userIds.push(id);
    i += 1 + bestLen;
  }

  return { text: out.join(''), userIds };
}
