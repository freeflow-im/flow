// Slack mrkdwn <-> Flow markdown conversion (phase4.md §1 "Formatting").
//
// Inbound (mrkdwnToMarkdown): what Slack SDKs send us -> what we store.
// Outbound (markdownToMrkdwn): what we store -> what Slack SDKs expect back.
//
// Coverage:
//   *bold*        <-> **bold**
//   _italic_      <-> _italic_        (identical syntax, passes through)
//   ~strike~      <-> ~~strike~~
//   `code` / ``` fences              (NOTHING inside code spans/fences converts)
//   <url|label>   <-> [label](url)
//   <url>         <-> bare url
//   <@userId>     <-> <@userId>       (Slack's syntax already matches storage; labels stripped)
//   <!channel|here|everyone>          (pass through; labels stripped)
//   &amp; &lt; &gt;                   (decoded inbound, re-encoded outbound)
//
// Documented LOSSY edges (degraded, never silently dropped):
//   <#C123|name>  -> #name            (channel id is dropped)
//   <#C123>       -> #channel         (no label available at all)
//   <!date^...|fallback> and other unknown <!...> special tokens -> fallback text
//   literal ** or ~~ in Slack input can pick up extra markers after conversion
//   %-encoded '*'/'~' inside URLs may be treated as formatting (URLs rarely contain them)

const CODE_SEGMENT_RE = /(```[\s\S]*?```|`[^`\n]+`)/g;

/** Apply fn to the non-code portions of text; code spans and fences pass through verbatim. */
function mapNonCode(text: string, fn: (seg: string) => string): string {
  const parts = text.split(CODE_SEGMENT_RE);
  // String.split with a capturing group alternates [text, code, text, code, ...]
  return parts.map((seg, i) => (i % 2 === 1 ? seg : fn(seg))).join('');
}

function decodeEntities(s: string): string {
  return s.replace(/&(amp|lt|gt);/g, (_, name: string) => ({ amp: '&', lt: '<', gt: '>' })[name]!);
}

function encodeEntities(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Render one Slack angle token (content between < and >) as markdown. */
function renderSlackToken(inner: string): string {
  const pipe = inner.indexOf('|');
  const head = pipe === -1 ? inner : inner.slice(0, pipe);
  const label = pipe === -1 ? null : inner.slice(pipe + 1);
  if (head.startsWith('@')) {
    // user mention — storage format is <@userId>; drop any display label
    return `<${head}>`;
  }
  if (head.startsWith('!')) {
    const kind = head.slice(1);
    if (kind === 'channel' || kind === 'here' || kind === 'everyone') return `<!${kind}>`;
    // unknown special token (<!date^...|fallback>, <!subteam^...>, ...) -> fallback text (lossy)
    return decodeEntities(label ?? kind);
  }
  if (head.startsWith('#')) {
    // channel link -> #name (lossy: the channel id is dropped; no label at all -> #channel)
    return label ? `#${decodeEntities(label)}` : '#channel';
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(head)) {
    const url = decodeEntities(head);
    return label !== null ? `[${decodeEntities(label)}](${url})` : url;
  }
  return `<${inner}>`; // unrecognized — leave untouched
}

/** One pass over a non-code segment: angle tokens + entity decoding. */
function convertSlackTokensAndEntities(seg: string): string {
  let out = '';
  let i = 0;
  while (i < seg.length) {
    const c = seg[i]!;
    if (c === '<') {
      const end = seg.indexOf('>', i + 1);
      if (end !== -1) {
        out += renderSlackToken(seg.slice(i + 1, end));
        i = end + 1;
        continue;
      }
    } else if (c === '&') {
      const m = /^&(amp|lt|gt);/.exec(seg.slice(i, i + 5));
      if (m) {
        out += { amp: '&', lt: '<', gt: '>' }[m[1] as 'amp' | 'lt' | 'gt'];
        i += m[0].length;
        continue;
      }
    }
    out += c;
    i++;
  }
  return out;
}

/** Slack mrkdwn -> stored markdown (inbound). */
export function mrkdwnToMarkdown(text: string): string {
  return mapNonCode(text, (seg) =>
    convertSlackTokensAndEntities(seg)
      .replace(/\*([^\s*](?:[^*\n]*[^\s*])?)\*/g, '**$1**')
      .replace(/~([^\s~](?:[^~\n]*[^\s~])?)~/g, '~~$1~~'),
  );
}

const STORAGE_TOKEN_RE = /^<(@[^<>|]+|!(?:channel|here|everyone))>/;
const MD_LINK_RE = /^\[([^\]\n]*)\]\(([^()\s]+)\)/;
const BARE_URL_RE = /^(?:https?:\/\/|mailto:)[^\s<>]+/i;

/** One pass over a non-code segment: mention passthrough, links, urls, entity encoding. */
function convertOutboundTokensAndEntities(seg: string): string {
  let out = '';
  let i = 0;
  while (i < seg.length) {
    const c = seg[i]!;
    const rest = seg.slice(i);
    if (c === '<') {
      const m = STORAGE_TOKEN_RE.exec(rest);
      if (m) {
        out += m[0]; // <@userId> / <!channel|here|everyone> — already Slack syntax
        i += m[0].length;
        continue;
      }
      out += '&lt;';
      i++;
      continue;
    }
    if (c === '[') {
      const m = MD_LINK_RE.exec(rest);
      if (m) {
        out += `<${encodeEntities(m[2]!)}|${encodeEntities(m[1]!)}>`;
        i += m[0].length;
        continue;
      }
    }
    if ((c === 'h' || c === 'H' || c === 'm' || c === 'M') && (i === 0 || !/[a-z0-9]/i.test(seg[i - 1]!))) {
      const m = BARE_URL_RE.exec(rest);
      if (m) {
        let url = m[0];
        const trail = /[.,;:!?]+$/.exec(url);
        if (trail) url = url.slice(0, -trail[0].length);
        out += `<${encodeEntities(url)}>`;
        i += url.length;
        continue;
      }
    }
    out += c === '&' ? '&amp;' : c === '>' ? '&gt;' : c;
    i++;
  }
  return out;
}

/** Stored markdown -> Slack mrkdwn (outbound). */
export function markdownToMrkdwn(text: string): string {
  return mapNonCode(text, (seg) =>
    convertOutboundTokensAndEntities(
      seg.replace(/\*\*([^\n]+?)\*\*/g, '*$1*').replace(/~~([^\n]+?)~~/g, '~$1~'),
    ),
  );
}
