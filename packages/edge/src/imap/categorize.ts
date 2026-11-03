// Gmail-style inbox tabs (docs/specs/mail-api.md, "Inbox tabs"): which tab an INBOX message goes to. Pure, so
// categorize.test.ts can feed it real header sets. Gmail accounts use Gmail's own categories (X-GM-RAW searches over UID ranges,
// gmailTabs.ts); every other server is classified here from a handful of headers. Either answer is
// cached per message in the Mail object's SQLite, and the tabs are read from that cache.
//
// The rules, in order (the first that matches decides, and its reason is kept for debugging):
//   1. the user's choice for this sender ("Move to tab") wins;
//   2. Social: the sender's domain is a social network;
//   3. Updates: GitHub, as Gmail does (notifications, security alerts);
//   4. Forums: a mailing list or discussion group (List-Post, Google Groups, Mailman, Discourse, groups.io);
//   5. Promotions: bulk marketing (a marketing sender's headers or bounce domain, a campaign Feedback-ID), or a
//      List-Unsubscribe without any sign of being transactional;
//   6. Updates: automated transactional mail (Auto-Submitted, no-reply and notification senders, transactional
//      sending services, issue trackers, calendars);
//   7. Primary: everything else, which means mail from people.

export const CATEGORIES = ['primary', 'promotions', 'social', 'updates', 'forums'] as const;
export type Category = (typeof CATEGORIES)[number];
export const TAB_CATEGORIES = ['promotions', 'social', 'updates', 'forums'] as const;
export type TabCategory = (typeof TAB_CATEGORIES)[number];
export interface Classification { category: Category; reason: string }

/** The headers asked for with each page (BODY.PEEK[HEADER.FIELDS (...)]): IMAP has no wildcards, so each name is listed. */
export const CATEGORY_HEADERS = [
  'from', 'sender', 'return-path', 'subject',
  'list-id', 'list-unsubscribe', 'list-post', 'precedence', 'auto-submitted', 'feedback-id', 'x-mailer',
  'x-campaign', 'x-campaignid', 'x-campaign-id', 'x-campaign-name', 'x-mailchimp-campaign', 'x-mc-user', 'x-mailchimp-id',
  'x-sg-eid', 'x-sg-id', 'x-ses-outgoing', 'x-ses-message-tags', 'x-mailgun-tag', 'x-mailgun-sid', 'x-pm-message-id', 'x-postmark-tag',
  'x-kmail-account', 'x-kmail-relay', 'x-braze-id', 'x-marketo-id', 'x-mktmail-sent', 'x-hs-cid', 'x-hubspot-mail-type', 'x-iterable-message-id',
  'x-github-reason', 'x-google-group-id', 'x-mailman-version', 'x-discourse-post-id', 'x-discourse-topic-id', 'x-jira-fingerprint', 'x-linear-team',
  'x-facebook-notify', 'x-linkedin-class', 'x-auto-response-suppress', 'x-amazon-mail-relay-type',
];

export type Headers = Map<string, string>;

/** A raw header block (what a HEADER.FIELDS fetch returns) as lower-cased names to unfolded values; repeats are joined. */
export function parseHeaders(raw: string | Uint8Array | undefined | null): Headers {
  const text = raw == null ? '' : typeof raw === 'string' ? raw : new TextDecoder('latin1').decode(raw);
  const out: Headers = new Map();
  for (const line of text.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    const value = line.slice(i + 1).trim();
    out.set(name, out.has(name) ? `${out.get(name)}, ${value}` : value);
  }
  return out;
}

/** The address part of a From-like value, lower-cased: `"Ann" <ann@x.test>` and `ann@x.test` both give `ann@x.test`. */
export function addressOf(value: string | null | undefined): string {
  if (!value) return '';
  const angled = /<([^<>@\s]+@[^<>\s]+)>/.exec(value);
  const bare = angled ? angled[1] : /([^\s<>"',;:()]+@[^\s<>"',;:()]+)/.exec(value)?.[1];
  return (bare ?? '').toLowerCase();
}
const domainOf = (address: string) => address.split('@')[1] ?? '';
const localOf = (address: string) => address.split('@')[0] ?? '';
const inDomain = (domain: string, list: readonly string[]) => list.some((d) => domain === d || domain.endsWith(`.${d}`));

const SOCIAL = [
  'facebook.com', 'facebookmail.com', 'fb.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com', 'tiktok.com', 'pinterest.com', 'reddit.com', 'redditmail.com',
  'nextdoor.com', 'discord.com', 'discordapp.com', 'meetup.com', 'quora.com', 'strava.com', 'bsky.app', 'bsky.social', 'mastodon.social', 'threads.net', 'snapchat.com',
  'tumblr.com', 'flickr.com', 'youtube.com', 'twitch.tv', 'goodreads.com', 'myspace.com', 'vk.com', 'whatsapp.com', 'telegram.org', 'messenger.com', 'medium.com', 'letterboxd.com',
];
/** Bounce (Return-Path / Sender) domains of the marketing senders: Mailchimp, Klaviyo, Braze, Marketo, HubSpot, Campaign Monitor, ... */
const MARKETING_DOMAINS = [
  'mcsv.net', 'rsgsv.net', 'mcdlv.net', 'mailchimpapp.net', 'mandrillapp.com', 'klaviyomail.com', 'klaviyodns.com', 'braze.com', 'braze.eu', 'appboy.com', 'mktomail.com', 'marketo.org',
  'hubspotemail.net', 'hs-email.net', 'createsend.com', 'cmail19.com', 'cmail20.com', 'exacttarget.com', 'sfmc-marketing.com', 'mailjet.com', 'sendinblue.com', 'brevo.com', 'mlsend.com',
  'mailerlite.com', 'convertkit-mail.com', 'ck.page', 'constantcontact.com', 'ccsend.com', 'emarsys.net', 'iterable.com', 'acemsd.com', 'activehosted.com', 'omnisend.com', 'drip.com',
];
/** Senders of automated, transactional mail: the local part names a machine, not a person. */
const AUTOMATED_LOCAL = /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|donotreply|notifications?|notify|alerts?|mailer-daemon|postmaster|bounces?|receipts?|billing|invoices?|payments?|orders?|order-update|shipment-tracking|shipping|shipment|delivery|auto-confirm|account|accounts|security|calendar-notification|calendar|automated|system|digest|updates)([-+._].*)?$/;
const TRANSACTIONAL_DOMAINS = ['github.com', 'atlassian.net', 'atlassian.com', 'linear.app', 'calendar.google.com', 'accounts.google.com', 'amazonses.com', 'sendgrid.net', 'mailgun.org', 'postmarkapp.com', 'sparkpostmail.com'];
const TRANSACTIONAL_SUBJECT = /\b(receipt|invoice|order|shipped|shipping|delivered|delivery|tracking|payment|statement|password|verification|verify|security alert|sign[- ]?in|login|2fa|one[- ]time|code|confirm(ation|ed)?|reservation|booking|itinerary|invitation:|updated invitation|accepted:|declined:|reminder)\b/i;

const has = (h: Headers, ...names: string[]) => names.some((n) => !!h.get(n));
const hasPrefix = (h: Headers, ...prefixes: string[]) => [...h.keys()].some((k) => prefixes.some((p) => k.startsWith(p)));

/** Which tab a message's own headers put it in, before the user's choices. */
export function classifyHeaders(h: Headers): Classification {
  const from = addressOf(h.get('from'));
  const domain = domainOf(from);
  const bounce = [addressOf(h.get('return-path')), addressOf(h.get('sender'))].map(domainOf).filter(Boolean);
  const listId = (h.get('list-id') ?? '').toLowerCase();
  const precedence = (h.get('precedence') ?? '').toLowerCase();
  const feedback = (h.get('feedback-id') ?? '').toLowerCase();
  const mailer = (h.get('x-mailer') ?? '').toLowerCase();
  const subject = h.get('subject') ?? '';

  if (domain && inDomain(domain, SOCIAL)) return { category: 'social', reason: `social network sender (${domain})` };
  if (h.has('x-facebook-notify') || h.has('x-linkedin-class')) return { category: 'social', reason: 'social network headers' };

  if (h.has('x-github-reason') || inDomain(domain, ['github.com'])) return { category: 'updates', reason: `GitHub notification${h.get('x-github-reason') ? ` (${h.get('x-github-reason')})` : ''}` };

  if (h.has('x-google-group-id') || /googlegroups\.com/.test(listId)) return { category: 'forums', reason: 'Google Groups' };
  if (h.has('x-mailman-version') || /mailman/.test(mailer)) return { category: 'forums', reason: 'Mailman list' };
  if (hasPrefix(h, 'x-discourse-') || /discourse/.test(listId)) return { category: 'forums', reason: 'Discourse' };
  if (/groups\.io/.test(listId) || inDomain(domain, ['groups.io'])) return { category: 'forums', reason: 'groups.io' };
  if (h.has('list-post') && !/^\s*no\b/i.test(h.get('list-post') ?? '')) return { category: 'forums', reason: 'mailing list (List-Post)' };

  const espMarketing =
    has(h, 'x-mailchimp-campaign', 'x-mc-user', 'x-mailchimp-id', 'x-kmail-account', 'x-kmail-relay', 'x-braze-id', 'x-marketo-id', 'x-mktmail-sent', 'x-hs-cid', 'x-iterable-message-id') ||
    hasPrefix(h, 'x-campaign') ||
    /mailchimp|klaviyo|braze|marketo|hubspot|campaign monitor|constant contact|sendinblue|brevo|mailerlite|convertkit|activecampaign|omnisend|iterable/.test(mailer) ||
    /marketing|newsletter|promo/.test(h.get('x-hubspot-mail-type') ?? '');
  if (espMarketing) return { category: 'promotions', reason: 'marketing sender headers' };
  const marketingBounce = bounce.find((d) => inDomain(d, MARKETING_DOMAINS));
  if (marketingBounce) return { category: 'promotions', reason: `marketing sender (${marketingBounce})` };
  if (/campaign|newsletter|promo|marketing|mkt|blast|bulk/.test(feedback.split(':')[0] ?? '') || /:(mc|newsletter|marketing|promo)(:|$)/.test(feedback)) return { category: 'promotions', reason: 'campaign Feedback-ID' };

  const autoGenerated = /^auto-generated/i.test(h.get('auto-submitted') ?? '');
  const automatedSender = !!from && AUTOMATED_LOCAL.test(localOf(from));
  const transactionalService = inDomain(domain, TRANSACTIONAL_DOMAINS) || bounce.some((d) => inDomain(d, TRANSACTIONAL_DOMAINS)) ||
    has(h, 'x-ses-outgoing', 'x-sg-eid', 'x-sg-id', 'x-mailgun-sid', 'x-pm-message-id', 'x-postmark-tag', 'x-amazon-mail-relay-type') || !!feedback;
  const tracker = has(h, 'x-jira-fingerprint', 'x-linear-team') || inDomain(domain, ['atlassian.net', 'linear.app']);
  const transactionalCue = autoGenerated || automatedSender || tracker || TRANSACTIONAL_SUBJECT.test(subject);

  if (h.has('list-unsubscribe') && !transactionalCue) {
    if (/^(bulk|list|junk)$/.test(precedence)) return { category: 'promotions', reason: `bulk mail (Precedence: ${precedence}) with List-Unsubscribe` };
    return { category: 'promotions', reason: listId ? 'newsletter (List-Id, List-Unsubscribe)' : 'List-Unsubscribe' };
  }

  if (tracker) return { category: 'updates', reason: 'issue tracker notification' };
  if (autoGenerated) return { category: 'updates', reason: 'Auto-Submitted: auto-generated' };
  if (automatedSender) return { category: 'updates', reason: `automated sender (${localOf(from)}@)` };
  if (transactionalService) return { category: 'updates', reason: 'sent through a transactional mail service' };
  if (/^(bulk|list|junk)$/.test(precedence)) return { category: 'updates', reason: `Precedence: ${precedence}` };
  if (h.has('list-unsubscribe')) return { category: 'updates', reason: 'List-Unsubscribe on a transactional message' };

  return { category: 'primary', reason: 'from a person' };
}

/** A message's tab, the user's choice for its sender first. */
export function classify(h: Headers, overrides?: ReadonlyMap<string, Category>): Classification {
  const sender = addressOf(h.get('from'));
  const chosen = sender ? overrides?.get(sender) : undefined;
  if (chosen) return { category: chosen, reason: `you moved mail from ${sender} here` };
  return classifyHeaders(h);
}

/** Where a message shows, given which tabs are on: a tab that is off sends its mail to Primary. */
export function effective(category: Category, enabled: readonly TabCategory[]): Category {
  return category !== 'primary' && enabled.includes(category) ? category : 'primary';
}

/** The tabs as stored and returned: known ones, once each, in the bar's order. */
export function normalizeTabs(tabs: readonly string[] | null | undefined): TabCategory[] {
  const set = new Set(tabs ?? []);
  return TAB_CATEGORIES.filter((t) => set.has(t));
}

// ---- Gmail ---------------------------------------------------------------------------------------------------------

/**
 * A tab's page from its cached UIDs below the cursor, newest first (`rows`: up to limit + 1 of them, all at or above the
 * cache's `low`). Full: `next` when more may follow (another cached row, or older mail not sorted yet). Short with older
 * mail not sorted yet (`low > 1`): `sorting`, and `next` where the cache ends, so the page can be asked for again once the
 * sorter has gone further, or the list carry on below it. Short with everything sorted: the end.
 */
export function tabPage(rows: readonly number[], limit: number, low: number, cursor: number): { page: number[]; next: number | null; sorting: boolean } {
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  if (rows.length > limit) return { page, next: last, sorting: false };
  if (low <= 1) return { page, next: null, sorting: false };
  if (page.length === limit) return { page, next: last, sorting: false };
  return { page, next: Math.min(cursor, low), sorting: true };
}

/** A UID set for a command, runs collapsed: [1,2,3,7,9,10] gives `1:3,7,9:10`. */
export function uidSet(uids: readonly number[]): string {
  const sorted = [...new Set(uids)].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const start = sorted[i];
    while (i + 1 < sorted.length && sorted[i + 1] === sorted[i] + 1) i++;
    out.push(start === sorted[i] ? String(start) : `${start}:${sorted[i]}`);
  }
  return out.join(',');
}

/**
 * The tab a cached row shows in, as SQL over `mail_categories c LEFT JOIN mail_category_overrides o` (the same as
 * `effective(override ?? category, tabs)`): the sender's chosen tab, else the stored one, and Primary for a tab that is off.
 */
export function effectiveSql(tabs: readonly TabCategory[]): { sql: string; params: string[] } {
  const enabled = normalizeTabs(tabs);
  if (!enabled.length) return { sql: "'primary'", params: [] };
  return { sql: `(CASE WHEN COALESCE(o.category, c.category) IN (${enabled.map(() => '?').join(', ')}) THEN COALESCE(o.category, c.category) ELSE 'primary' END)`, params: enabled };
}

export const isGmailHost = (host: string) => /(^|\.)(gmail|googlemail)\.com$/i.test(host.trim());
