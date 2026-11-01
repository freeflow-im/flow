// Body rendering (mention pills + block-level markdown) and outgoing
// transforms — the web twin of the macOS MentionRendering/prepareOutgoing pair.
//
// Phase 3.5 item 2: bodies stay literal markdown on the wire; ``` fenced code
// and ">" quote lines gain block styling at render time, and outgoing sugar
// (shortcodes, mentions) is not expanded inside fenced code regions.
//
// Block markdown extended to headings (#…######), unordered/ordered lists,
// GFM pipe tables, and horizontal rules — all rendered at display time; the
// wire format stays literal so other clients still show plain markdown.
import { createContext, Fragment, useContext } from 'react';
import type { ReactNode } from 'react';
import type { WorkspaceEmojiDTO, WorkspaceMemberDTO } from '@flow/shared';
import { expandShortcodes } from '@flow/shared';
import { CodeBlock } from '../components/CodeBlock';
import { MermaidBlock } from '../components/MermaidBlock';
import { CustomEmojiImage } from '../components/CustomEmoji';

/** Lets a message row offer "Pin as artifact" on every inline link it renders,
 * without threading a callback through the recursive renderer. Rendering sites
 * that don't provide it (previews, etc.) just get plain links. */
export const InlineLinkContext = createContext<{ onPinLink?: (url: string) => void; onOpenArtifact?: (id: string) => void }>({});

/** The workspace's custom emoji, keyed `:shortcode:`, for `:name:` in message
 * text (#175 drew them only in reactions). Without a provider every shortcode
 * stays text, which is also what an unknown or deleted emoji shows. */
export const CustomEmojiContext = createContext<Record<string, WorkspaceEmojiDTO>>({});

// A `:shortcode:`, or one unicode emoji: a pictograph or flag pair with its
// variation selector, skin tone, keycap and ZWJ-joined parts.
const EMOJI_RE = /(:[a-z0-9_+'-]+:)|((?:\p{Regional_Indicator}{2}|\p{Extended_Pictographic})(?:\uFE0F|\u20E3|\p{Emoji_Modifier}|\u200D(?:\p{Extended_Pictographic})\uFE0F?)*)/gu;

// Emoji in text read at Slack's size: about 1.4x the letters around them,
// without growing the line they sit on.
const INLINE_EMOJI_SIZE = '1.4em';

function InlineCustomEmoji({ code }: { code: string }) {
  const emoji = useContext(CustomEmojiContext)[code];
  return emoji ? <CustomEmojiImage emoji={emoji} size={INLINE_EMOJI_SIZE} /> : <>{code}</>;
}

/** Plain text with emoji sized up and any `:shortcode:` handed to InlineCustomEmoji. */
function withEmoji(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(EMOJI_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${keyBase}e${key++}`;
    out.push(m[1] !== undefined
      ? <InlineCustomEmoji key={k} code={m[1]} />
      : <span key={k} data-emoji className="align-[-0.1em] text-[1.4em] leading-none">{m[2]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A link in a message body: opens in a new tab, and — when a pin handler is in
 * context — reveals a small 📌 on hover to pin the URL as a co-browsing artifact. */
function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  const { onPinLink, onOpenArtifact } = useContext(InlineLinkContext);
  if (href.startsWith('flow-artifact:')) {
    const id = href.slice('flow-artifact:'.length);
    return onOpenArtifact ? (
      <button type="button" data-testid="open-report" onClick={() => onOpenArtifact(id)}
        className="my-2 block max-w-full rounded-lg border border-hairline bg-white px-4 py-3 text-left font-semibold text-accent-deep hover:border-accent">
        📄 {children}
      </button>
    ) : <span>{children}</span>;
  }
  const a = (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-accent-deep underline">
      {children}
    </a>
  );
  if (!onPinLink) return a;
  return (
    <span className="group/lnk relative inline-flex items-baseline">
      {a}
      <button
        type="button"
        data-testid="inline-link-pin"
        title="Pin as artifact"
        aria-label="Pin as artifact"
        className="ml-0.5 rounded px-0.5 align-baseline text-[0.85em] leading-none opacity-0 group-hover/lnk:opacity-100 hover:bg-daypill"
        onClick={(e) => {
          e.preventDefault();
          onPinLink(href);
        }}
      >
        📌
      </button>
    </span>
  );
}

// User ids are Flow UUIDs.
const TOKEN_RE = /<@([0-9a-fA-F-]{36})>|<!(channel|here|everyone)>/g;

// Inline markdown (agent replies lean on it heavily): `code`, **bold**,
// *italic* / _italic_, ~~strike~~, [label](url), bare URLs. Code spans win
// over everything inside them; emphasis requires non-space at both edges so
// "2 * 3 * 4" and snake_case stay literal. Applied to plain/quote segments
// only — fenced code blocks never get here.
const INLINE_RE =
  /(`[^`\n]+`)|(\*\*(?=\S)(?:[^*\n]|\*(?!\*))+?(?<=\S)\*\*)|(\*(?!\*)(?=\S)[^*\n]+?(?<=\S)\*)|((?<![\w`])_(?=\S)[^_\n]+?(?<=\S)_(?![\w`]))|(~~(?=\S)[^~\n]+?(?<=\S)~~)|\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|flow-artifact:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\)|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(...withEmoji(text.slice(last, m.index), `${keyBase}p${key}`));
    const k = `${keyBase}i${key++}`;
    if (m[1] !== undefined) {
      out.push(
        <code key={k} className="rounded bg-[#f4f2ee] px-1 py-px font-mono text-[0.92em] text-[#c2544a]">
          {m[1].slice(1, -1)}
        </code>,
      );
    } else if (m[2] !== undefined) {
      out.push(<strong key={k}>{renderInline(m[2].slice(2, -2), k)}</strong>);
    } else if (m[3] !== undefined || m[4] !== undefined) {
      const inner = (m[3] ?? m[4])!.slice(1, -1);
      out.push(<em key={k}>{renderInline(inner, k)}</em>);
    } else if (m[5] !== undefined) {
      out.push(<s key={k}>{renderInline(m[5].slice(2, -2), k)}</s>);
    } else if (m[6] !== undefined && m[7] !== undefined) {
      out.push(
        <InlineLink key={k} href={m[7]}>
          {m[6]}
        </InlineLink>,
      );
    } else if (m[8] !== undefined) {
      out.push(
        <InlineLink key={k} href={m[8]}>
          {m[8]}
        </InlineLink>,
      );
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(...withEmoji(text.slice(last), `${keyBase}t`));
  return out;
}

/** Stored tokens → React nodes with pills; inline markdown on the text runs between them. */
export function renderBody(
  body: string,
  names: Record<string, string>,
  currentUserId: string | undefined,
): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let key = 0;
  for (const m of body.matchAll(TOKEN_RE)) {
    if (m.index > last) out.push(...renderInline(body.slice(last, m.index), `t${key}`));
    const strong = m[2] !== undefined || m[1] === currentUserId;
    const label = m[2] !== undefined ? `@${m[2]}` : `@${names[m[1]!] ?? 'someone'}`;
    out.push(
      <span
        key={`m${key++}`}
        data-mention={m[2] ?? m[1]}
        className={
          strong
            ? 'rounded bg-accent px-1 font-semibold text-white'
            : 'rounded bg-accent/15 px-1 font-semibold text-accent-deep'
        }
      >
        {label}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < body.length) out.push(...renderInline(body.slice(last), `t${key}`));
  return out;
}

/** Line-level block kinds. A ``` line toggles a code region; ">" only counts outside code. */
export type LineKind = 'plain' | 'quote' | 'fence' | 'code';

export function classifyLines(lines: string[]): LineKind[] {
  let inCode = false;
  return lines.map((line) => {
    if (line.startsWith('```')) {
      inCode = !inCode;
      return 'fence';
    }
    if (inCode) return 'code';
    return line.startsWith('>') ? 'quote' : 'plain';
  });
}

export type CellAlign = 'left' | 'center' | 'right' | null;

export type BodySegment =
  | { kind: 'code'; content: string } // fence marker lines stripped
  | { kind: 'mermaid'; content: string } // ```mermaid — rendered as a diagram
  | { kind: 'quote'; content: string } // leading "> " stripped per line
  | { kind: 'heading'; level: number; content: string } // "#"…"######" stripped
  | { kind: 'ulist'; items: string[] } // "- "/"* "/"+ " markers stripped
  | { kind: 'olist'; start: number; items: string[] } // "N." markers stripped
  | { kind: 'table'; header: string[]; align: CellAlign[]; rows: string[][] }
  | { kind: 'hr' }
  | { kind: 'plain'; content: string };

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const HR_RE = /^(-{3,}|\*{3,}|_{3,})\s*$/;
const ULIST_RE = /^\s*[-*+]\s+(.*)$/;
const OLIST_RE = /^\s*(\d+)\.\s+(.*)$/;

/**
 * The info string of an opening fence — `mermaid` in "```mermaid". Case and
 * surrounding space are ignored, and only the first word counts, so
 * "```Mermaid  " and "```mermaid theme=x" are both diagrams. Kept in step with
 * `MarkdownBlocks.fenceLanguage` on the Swift side so all three clients agree
 * on what is a diagram.
 */
export function fenceLanguage(line: string): string {
  return line.slice(3).trim().split(/\s+/)[0]!.toLowerCase();
}

/** A GFM table separator row: pipes, dashes, optional colons — and at least one of each. */
function isTableSep(line: string): boolean {
  return line.includes('|') && line.includes('-') && /^[\s|:-]+$/.test(line);
}

/** A table header row must carry a pipe and be followed by a separator row. */
function isTableStart(lines: string[], i: number): boolean {
  return lines[i]!.includes('|') && i + 1 < lines.length && isTableSep(lines[i + 1]!);
}

/** Split "| a | b |" into ['a','b'], tolerating optional outer pipes. */
function parseRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function parseAlign(cell: string): CellAlign {
  const left = cell.startsWith(':');
  const right = cell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

/** True when a line begins a non-plain block — the plain-run terminator. */
function startsBlock(lines: string[], i: number): boolean {
  const l = lines[i]!;
  return (
    l.startsWith('```') ||
    l.startsWith('>') ||
    HEADING_RE.test(l) ||
    HR_RE.test(l) ||
    ULIST_RE.test(l) ||
    OLIST_RE.test(l) ||
    isTableStart(lines, i)
  );
}

/** Split a body into fenced code, quotes, headings, lists, tables, rules, and plain paragraphs. */
export function segmentBody(body: string): BodySegment[] {
  const segments: BodySegment[] = [];
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('```')) {
      const lang = fenceLanguage(line);
      const content: string[] = [];
      i++; // opening fence
      while (i < lines.length && !lines[i]!.startsWith('```')) {
        content.push(lines[i]!);
        i++;
      }
      if (i < lines.length) i++; // closing fence
      const body = content.join('\n');
      // An empty ```mermaid block has nothing to draw — leave it a code block.
      segments.push(
        lang === 'mermaid' && body.trim() !== ''
          ? { kind: 'mermaid', content: body }
          : { kind: 'code', content: body },
      );
    } else if (line.startsWith('>')) {
      const content: string[] = [];
      while (i < lines.length && lines[i]!.startsWith('>')) {
        content.push(lines[i]!.replace(/^>\s?/, ''));
        i++;
      }
      segments.push({ kind: 'quote', content: content.join('\n') });
    } else if (HEADING_RE.test(line)) {
      const m = HEADING_RE.exec(line)!;
      segments.push({ kind: 'heading', level: m[1]!.length, content: m[2]! });
      i++;
    } else if (HR_RE.test(line)) {
      segments.push({ kind: 'hr' });
      i++;
    } else if (isTableStart(lines, i)) {
      const header = parseRow(line);
      const align = parseRow(lines[i + 1]!).map(parseAlign);
      i += 2; // header + separator
      const rows: string[][] = [];
      while (i < lines.length && lines[i]!.includes('|') && lines[i]!.trim() !== '' && !lines[i]!.startsWith('```')) {
        rows.push(parseRow(lines[i]!));
        i++;
      }
      segments.push({ kind: 'table', header, align, rows });
    } else if (ULIST_RE.test(line)) {
      const items: string[] = [];
      while (i < lines.length && ULIST_RE.test(lines[i]!)) {
        items.push(ULIST_RE.exec(lines[i]!)![1]!);
        i++;
      }
      segments.push({ kind: 'ulist', items });
    } else if (OLIST_RE.test(line)) {
      const start = parseInt(OLIST_RE.exec(line)![1]!, 10);
      const items: string[] = [];
      while (i < lines.length && OLIST_RE.test(lines[i]!)) {
        items.push(OLIST_RE.exec(lines[i]!)![2]!);
        i++;
      }
      segments.push({ kind: 'olist', start: Number.isFinite(start) ? start : 1, items });
    } else {
      const content: string[] = [];
      while (i < lines.length && !startsBlock(lines, i)) {
        content.push(lines[i]!);
        i++;
      }
      segments.push({ kind: 'plain', content: content.join('\n') });
    }
  }
  return segments;
}

const HEADING_CLASS: Record<number, string> = {
  1: 'mt-2 mb-1 text-lg font-bold',
  // NB: avoid `text-base` — it collides with the custom `--color-base` theme
  // token in Tailwind v4 and paints the heading near-white on the base bg.
  2: 'mt-2 mb-1 text-[1.05rem] font-bold',
  3: 'mt-1.5 mb-0.5 text-sm font-bold',
  4: 'mt-1.5 mb-0.5 text-sm font-semibold',
  5: 'mt-1 mb-0.5 text-sm font-semibold',
  6: 'mt-1 mb-0.5 text-sm font-semibold',
};

const ALIGN_CLASS: Record<'left' | 'center' | 'right', string> = {
  left: 'text-left',
  center: 'text-center',
  right: 'text-right',
};

/**
 * Block-level body renderer: code → a CodeBlock (no mention pills, fences
 * hidden, copy button), ```mermaid → a sandboxed diagram frame, quotes → <blockquote>,
 * headings → sized/bold, lists → <ul>/<ol>,
 * tables → a scrollable <table>, rules → <hr>, plain text through renderBody.
 * Inline content (mention pills + inline markdown) runs through renderBody
 * inside every text-bearing block. Render inside a whitespace-pre-wrap
 * container (block elements override it locally where needed).
 */
export function renderBlocks(
  body: string,
  names: Record<string, string>,
  currentUserId: string | undefined,
): ReactNode[] {
  const inline = (text: string) => renderBody(text, names, currentUserId);
  return segmentBody(body).map((seg, i): ReactNode => {
    const key = `b${i}`;
    if (seg.kind === 'code') {
      return <CodeBlock key={key} source={seg.content} />;
    }
    if (seg.kind === 'mermaid') {
      return <MermaidBlock key={key} source={seg.content} />;
    }
    if (seg.kind === 'quote') {
      return (
        <blockquote
          key={key}
          data-testid="quote-block"
          className="my-1 border-l-[3px] border-accent bg-accent/5 py-0.5 pr-2 pl-2.5 text-ink-soft"
        >
          {inline(seg.content)}
        </blockquote>
      );
    }
    if (seg.kind === 'heading') {
      const Tag = `h${Math.min(seg.level, 6)}` as 'h1';
      return (
        <Tag key={key} data-testid="heading" className={HEADING_CLASS[seg.level] ?? HEADING_CLASS[6]}>
          {inline(seg.content)}
        </Tag>
      );
    }
    if (seg.kind === 'hr') {
      return <hr key={key} data-testid="rule" className="my-2 border-t border-hairline" />;
    }
    if (seg.kind === 'ulist') {
      return (
        <ul key={key} data-testid="ulist" className="my-1 list-disc space-y-0.5 pl-5">
          {seg.items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </ul>
      );
    }
    if (seg.kind === 'olist') {
      return (
        <ol key={key} data-testid="olist" start={seg.start} className="my-1 list-decimal space-y-0.5 pl-5">
          {seg.items.map((it, j) => (
            <li key={j}>{inline(it)}</li>
          ))}
        </ol>
      );
    }
    if (seg.kind === 'table') {
      const cols = seg.header.length;
      const cellAlign = (c: number) => {
        const a = seg.align[c];
        return a ? ` ${ALIGN_CLASS[a]}` : '';
      };
      return (
        <div key={key} data-testid="table" className="my-1 max-w-full overflow-x-auto">
          <table className="border-collapse text-[13px]">
            <thead>
              <tr>
                {seg.header.map((cell, c) => (
                  <th
                    key={c}
                    className={`border border-hairline2 bg-[#f4f2ee] px-2 py-1 font-semibold${cellAlign(c) || ' text-left'}`}
                  >
                    {inline(cell)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {seg.rows.map((row, r) => (
                <tr key={r}>
                  {Array.from({ length: cols }, (_, c) => (
                    <td key={c} className={`border border-hairline px-2 py-1${cellAlign(c)}`}>
                      {inline(row[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    return <Fragment key={key}>{inline(seg.content)}</Fragment>;
  });
}

/** Token-free plain text (notification previews, browser banners). Fence marker lines are dropped. */
export function plainBody(body: string, names: Record<string, string>): string {
  const visible = body
    .split('\n')
    .filter((line) => !line.startsWith('```'))
    .join('\n');
  return visible.replace(TOKEN_RE, (_all, id?: string, group?: string) =>
    group !== undefined ? `@${group}` : `@${names[id!] ?? 'someone'}`,
  );
}

/**
 * Composer sugar → wire format: :shortcode: → unicode, @channel|here|everyone
 * → <!token>, @Display Name → <@id> (longest name first). Fenced code regions
 * (fence markers included) pass through untouched; quote lines still expand.
 * Returns resolved mention ids for the server to validate.
 */
export function transformOutgoing(
  text: string,
  members: WorkspaceMemberDTO[],
): { body: string; mentions: string[] } {
  const lines = text.split('\n');
  const kinds = classifyLines(lines);
  const mentions = new Set<string>();
  const out: string[] = [];
  let run: string[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    out.push(transformSegment(run.join('\n'), members, mentions));
    run = [];
  };
  lines.forEach((line, i) => {
    if (kinds[i] === 'fence' || kinds[i] === 'code') {
      flushRun();
      out.push(line);
    } else {
      run.push(line);
    }
  });
  flushRun();
  return { body: out.join('\n'), mentions: [...mentions] };
}

function transformSegment(text: string, members: WorkspaceMemberDTO[], mentions: Set<string>): string {
  let body = expandShortcodes(text);
  for (const token of ['channel', 'here', 'everyone']) {
    body = body.split(`@${token}`).join(`<!${token}>`);
  }
  const sorted = [...members].sort((a, b) => b.displayName.length - a.displayName.length);
  for (const m of sorted) {
    if (!m.displayName) continue;
    const needle = `@${m.displayName}`;
    if (body.includes(needle)) {
      body = body.split(needle).join(`<@${m.userId}>`);
      mentions.add(m.userId);
    }
  }
  return body;
}

export function displayTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return sameDay ? time : `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
