// A video call as the event card shows it (Google's card is the model): the join link with its provider's name, and the
// dial-in that Google Meet and Zoom put in the description, read out of it; the same blocks are taken out of the
// description shown, so the card's description row has only what a person wrote.
import type { EventOccurrence } from '../api';

export interface DialIn { text: string; tel: string; pin: string | null }
export interface Conference {
  url: string;
  /** "Join with Google Meet", "Join Zoom Meeting", "Join Microsoft Teams meeting", "Join video call". */
  label: string;
  /** The link as the card prints it under the button: no scheme, no query. */
  shown: string;
  dialIn?: DialIn;
  morePhones?: string;
  meetingId?: string;
  passcode?: string;
}

const PROVIDERS: [RegExp, string][] = [
  [/^https:\/\/meet\.google\.com\//i, 'Join with Google Meet'],
  [/^https:\/\/[\w.-]*zoom\.us\//i, 'Join Zoom Meeting'],
  [/^https:\/\/teams\.(microsoft|live)\.com\//i, 'Join Microsoft Teams meeting'],
  [/^https:\/\/[\w.-]*webex\.com\//i, 'Join Webex meeting'],
];
const URL_RE = /https?:\/\/[^\s<>"')]+/i;
/** Google's delimiter line around its Meet block: `-::~:~::~:~ … ::~:~::-`. */
const GOOGLE_FENCE = /^-::~[:~]*::-\s*$/;

export const labelFor = (url: string) => PROVIDERS.find(([re]) => re.test(url))?.[1] ?? 'Join video call';
export const shownUrl = (url: string) => url.replace(/^https?:\/\//, '').replace(/[?#].*$/, '');

/** A PIN in threes, as Google prints it: `522324683#` → `522 324 683#`. */
export const groupPin = (pin: string) => { const digits = pin.replace(/\D/g, ''); return `${digits.replace(/(\d{3})(?=\d)/g, '$1 ')}${pin.trim().endsWith('#') ? '#' : ''}`; };

/** `(US) +1 413-752-4874 PIN: 522324683#` → the text to show and a tel: link that dials the PIN after the number. */
export function dialIn(line: string): DialIn | null {
  const m = /^(?:Or dial:\s*)?(\([A-Z]{2}\)\s*)?(\+?[\d][\d\s().-]{5,}\d)(?:\s*PIN:\s*([\d\s]+#?))?/i.exec(line.trim());
  if (!m) return null;
  const number = (m[2] ?? '').trim(), pin = m[3]?.trim() ?? null;
  const digits = number.replace(/[^\d+]/g, '');
  return { text: `${m[1] ?? ''}${number}${pin ? ` PIN: ${groupPin(pin)}` : ''}`, tel: `tel:${digits}${pin ? `,,${pin.replace(/\D/g, '')}%23` : ''}`, pin: pin ? groupPin(pin) : null };
}

interface Parsed { url?: string; dialIn?: DialIn; morePhones?: string; meetingId?: string; passcode?: string }

/** Google Meet's block in a description: what it holds, and the description without it. */
function googleBlock(text: string): { found: Parsed | null; rest: string } {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => GOOGLE_FENCE.test(l.trim()));
  if (start < 0) return { found: null, rest: text };
  let end = lines.findIndex((l, i) => i > start && GOOGLE_FENCE.test(l.trim()));
  if (end < 0) end = lines.length - 1;
  const found: Parsed = {};
  for (const l of lines.slice(start + 1, end)) {
    const join = /^Join with Google Meet:\s*(\S+)/i.exec(l.trim());
    if (join) found.url = join[1];
    if (/^Or dial:/i.test(l.trim())) found.dialIn = dialIn(l) ?? undefined;
    const more = /^More phone numbers:\s*(\S+)/i.exec(l.trim());
    if (more) found.morePhones = more[1];
  }
  return { found, rest: [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n') };
}

/** Zoom's invitation text ("Join Zoom Meeting", the link, Meeting ID, Passcode, the phone numbers): read, and taken out. */
function zoomBlock(text: string): { found: Parsed | null; rest: string } {
  const lines = text.split(/\r?\n/);
  // "Join Zoom Meeting" on its own line, or the Zoom add-on's "This is a Zoom meeting. Click this link to join: <link>".
  const start = lines.findIndex((l) => /^\s*(Join Zoom Meeting|This is a Zoom meeting\.? Click this link to join:.*)\s*$/i.test(l));
  if (start < 0) return { found: null, rest: text };
  const found: Parsed = {};
  const first = lines[start] ?? '';
  if (/zoom\.us\//i.test(first)) found.url = URL_RE.exec(first)?.[0];
  let end = start;
  for (let i = start + 1; i < lines.length; i++) {
    const l = (lines[i] ?? '').trim();
    if (!found.url && /zoom\.us\//i.test(l)) { found.url = URL_RE.exec(l)?.[0]; end = i; continue; }
    const id = /^Meeting ID:\s*([\d ]+)/i.exec(l);
    if (id) { found.meetingId ??= (id[1] ?? '').trim(); end = i; continue; }
    const pass = /^Passcode:\s*(\S+)/i.exec(l);
    if (pass) { found.passcode ??= pass[1]; end = i; continue; }
    const local = /^Find your local number:\s*(\S+)/i.exec(l);
    if (local) { found.morePhones = local[1]; end = i; continue; }
    const tap = /^(\+[\d]+),,(\d+)#/.exec(l);
    if (tap && !found.dialIn) { found.dialIn = { text: `${tap[1]} Meeting ID: ${found.meetingId ?? tap[2]}`, tel: `tel:${tap[1]},,${tap[2]}%23`, pin: null }; end = i; continue; }
    // The rest of Zoom's block: its separators, headings and number lists, up to "Find your local number" or SIP/H.323.
    if (l === '' || /^(---|One tap mobile|Dial by your location|Join by SIP|Join by H\.323|Meeting ID|Passcode|\+?\d[\d\s,#*]+.*|\S+@zoomcrc\.com|[\d.]+ \(.*\)|Join instructions.*|Zoom (Meeting|is inviting).*|Topic:.*|Time:.*|.*is inviting you to a scheduled Zoom meeting\.?)$/i.test(l)) { if (l) end = i; continue; }
    break;
  }
  return { found, rest: [...lines.slice(0, start), ...lines.slice(end + 1)].join('\n') };
}

/** The description as the card shows it: Google's and Zoom's blocks out, blank lines at the ends trimmed; null when nothing is left. */
export function shownDescription(description: string | null): string | null {
  if (!description) return null;
  const text = zoomBlock(googleBlock(descriptionText(description)).rest).rest.replace(/\n{3,}/g, '\n\n').trim();
  return text || null;
}

/** The event's video call, from the server's `conference`, else what its description's blocks say. */
export function conferenceOf(o: Pick<EventOccurrence, 'conference' | 'description' | 'location'>): Conference | null {
  const text = o.description ? descriptionText(o.description) : null;
  const g = text ? googleBlock(text).found : null;
  const z = text ? zoomBlock(text).found : null;
  const block = g?.url ? g : z?.url ? z : g ?? z;
  const url = o.conference?.url ?? block?.url ?? null;
  if (!url) return null;
  const mine = block && (!block.url || block.url === url) ? block : null;
  return {
    url, label: labelFor(url), shown: shownUrl(url),
    ...(mine?.dialIn ? { dialIn: mine.dialIn } : {}), ...(mine?.morePhones ? { morePhones: mine.morePhones } : {}),
    ...(mine?.meetingId ? { meetingId: mine.meetingId } : {}), ...(mine?.passcode ? { passcode: mine.passcode } : {}),
  };
}

const HTML_TAG = /<\/?(a|br|p|div|span|b|i|u|strong|em|ul|ol|li|h[1-6]|html|body|font)\b[^>]*>/i;
const BLOCK = new Set(['P', 'DIV', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

/** A description as plain text. Google Calendar (and Zoom's invitations) store descriptions as HTML: line breaks, lists
 *  and entities become text, and a link whose words differ from its address becomes `[words](address)`, which
 *  `linkify` shows as those words. Plain text comes back as it is. */
export function descriptionText(description: string): string {
  if (!HTML_TAG.test(description) || typeof DOMParser === 'undefined') return description;
  const doc = new DOMParser().parseFromString(description, 'text/html');
  let out = '';
  const walk = (node: Node) => {
    for (const n of Array.from(node.childNodes)) {
      if (n.nodeType === 3) { out += (n.textContent ?? '').replace(/\n/g, ' '); continue; }
      if (n.nodeType !== 1) continue;
      const el = n as Element;
      const tag = el.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') continue;
      if (tag === 'BR') { out += '\n'; continue; }
      if (tag === 'A') {
        const href = el.getAttribute('href') ?? '';
        const words = (el.textContent ?? '').trim();
        if (/^(https?:|mailto:)/i.test(href) && words && words !== href && !/^https?:\/\//i.test(words)) out += `[${words.replace(/[[\]]/g, '')}](${href})`;
        else out += /^https?:/i.test(href) ? href : words;
        continue;
      }
      const block = BLOCK.has(tag) || tag === 'LI';
      if (block && out && !out.endsWith('\n')) out += '\n';
      if (tag === 'LI') out += '• ';
      walk(el);
      if (block && !out.endsWith('\n')) out += '\n';
    }
  };
  walk(doc.body);
  return out.replace(/[ \t]+\n/g, '\n').replace(/\u00a0/g, ' ');
}

/** Text with its links as parts, for a description that keeps its line breaks and makes links clickable.
 *  `[words](address)`, from an HTML link, is a link shown as its words. */
export function linkify(text: string): ({ text: string } | { url: string; label?: string })[] {
  const out: ({ text: string } | { url: string; label?: string })[] = [];
  const re = /\[([^\]\n]+)\]\(((?:https?:|mailto:)[^\s)]+)\)|https?:\/\/[^\s<>"]+[^\s<>".,;:!?)\]]/gi;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > at) out.push({ text: text.slice(at, m.index) });
    out.push(m[1] ? { url: m[2]!, label: m[1] } : { url: m[0] });
    at = m.index! + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
