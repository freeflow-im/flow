import { describe, expect, it } from 'vitest';
import { addressOf, classify, classifyHeaders, effective, gmailQuery, normalizeTabs, parseHeaders, type Category } from './categorize';

const h = (raw: string) => parseHeaders(raw.trim().split('\n').map((l) => l.replace(/^ {4}/, '')).join('\r\n'));

const MAILCHIMP = h(`
    From: "The Outdoor Shop" <hello@outdoorshop.com>
    Subject: 20% off everything this weekend only
    Return-Path: <bounce-mc.us5_12345.6789-ann=example.com@mail42.atl11.rsgsv.net>
    List-Unsubscribe: <https://outdoorshop.us5.list-manage.com/unsubscribe?u=abc&id=def>, <mailto:unsubscribe-mc.us5_abc@unsubscribe.mailchimpapp.net>
    List-Id: Outdoor Shop <abc123.list-id.mcsv.net>
    X-Mailer: MailChimp Mailer - **CID9f8e7d6c5b**
    X-Campaign: mailchimpabc.9f8e7d6c5b
    X-campaignid: mailchimpabc.9f8e7d6c5b
    X-MC-User: abc123
    Feedback-ID: 12345:12345.6789:us5:mc
    Precedence: bulk
`);
const LINKEDIN = h(`
    From: Priya Shah via LinkedIn <invitations@linkedin.com>
    Subject: Priya Shah wants to connect
    List-Unsubscribe: <https://www.linkedin.com/e/v2?e=abc&a=unsub>
    X-LinkedIn-Class: INVITE-GUEST
    X-LinkedIn-Template: invite_guest_17
    Feedback-ID: invitation_guest:linkedin
`);
const GITHUB = h(`
    From: Chen Wei <notifications@github.com>
    Subject: Re: [acme/web] Fix flaky upload test (PR #812)
    List-ID: acme/web <web.acme.github.com>
    List-Archive: https://github.com/acme/web
    List-Unsubscribe: <mailto:unsub+abc@reply.github.com>, <https://github.com/notifications/unsubscribe/abc>
    X-GitHub-Reason: review_requested
    X-GitHub-Sender: chen-wei
    Precedence: list
`);
const AMAZON = h(`
    From: "Amazon.com" <shipment-tracking@amazon.com>
    Subject: Your Amazon.com order #112-1234567-7654321 has shipped
    Return-Path: <202311031234abcd@bounces.amazon.com>
    X-AMAZON-MAIL-RELAY-TYPE: notification
    Feedback-ID: 1.us-east-1.abcdefg=:AmazonSES
    X-SES-Outgoing: 2026.11.03-54.240.8.97
`);
const GOOGLE_GROUP = h(`
    From: Sam Rivera <sam@rivera.dev>
    Subject: [rust-embedded] Re: HAL traits for async SPI
    List-Id: <rust-embedded.googlegroups.com>
    List-Post: <https://groups.google.com/group/rust-embedded/post>, <mailto:rust-embedded@googlegroups.com>
    List-Unsubscribe: <mailto:rust-embedded+unsubscribe@googlegroups.com>
    X-Google-Group-Id: 123456789012
    Precedence: list
    Mailing-list: list rust-embedded@googlegroups.com; contact rust-embedded+owners@googlegroups.com
`);
const COLLEAGUE = h(`
    From: Bob Martin <bob@acme.test>
    Subject: Lunch on Thursday? And the order of talks
    X-Mailer: Apple Mail (2.3774.200.91.1.1)
`);

describe('classifyHeaders', () => {
  it('puts a Mailchimp newsletter in Promotions', () => expect(classifyHeaders(MAILCHIMP)).toMatchObject({ category: 'promotions', reason: 'marketing sender headers' }));
  it('puts a LinkedIn invitation in Social', () => expect(classifyHeaders(LINKEDIN)).toMatchObject({ category: 'social', reason: 'social network sender (linkedin.com)' }));
  it('puts a GitHub pull request notification in Updates, as Gmail does', () => expect(classifyHeaders(GITHUB)).toMatchObject({ category: 'updates', reason: 'GitHub notification (review_requested)' }));
  it('puts an Amazon shipping notice in Updates', () => expect(classifyHeaders(AMAZON).category).toBe('updates'));
  it('puts a Google Groups thread in Forums', () => expect(classifyHeaders(GOOGLE_GROUP)).toMatchObject({ category: 'forums', reason: 'Google Groups' }));
  it("keeps a colleague's mail in Primary", () => expect(classifyHeaders(COLLEAGUE)).toEqual({ category: 'primary', reason: 'from a person' }));

  it('Forums: a list with List-Post, a Mailman list and Discourse', () => {
    expect(classifyHeaders(h('From: a@b.org\nList-Id: <dev.lists.b.org>\nList-Post: <mailto:dev@lists.b.org>')).category).toBe('forums');
    expect(classifyHeaders(h('From: a@b.org\nX-Mailman-Version: 2.1.39\nList-Id: <x.b.org>')).category).toBe('forums');
    expect(classifyHeaders(h('From: forum@meta.discourse.org\nX-Discourse-Post-Id: 12\nList-Unsubscribe: <https://x>')).category).toBe('forums');
    // "List-Post: NO" is a list that takes no posts: an announcement, not a discussion.
    expect(classifyHeaders(h('From: news@b.org\nList-Post: NO\nList-Unsubscribe: <https://b.org/u>\nList-Id: <news.b.org>')).category).toBe('promotions');
  });
  it('Promotions: a Klaviyo bounce domain, a campaign Feedback-ID, a bulk newsletter', () => {
    expect(classifyHeaders(h('From: shop@brand.com\nReturn-Path: <bounce@send.klaviyomail.com>')).category).toBe('promotions');
    expect(classifyHeaders(h('From: deals@brand.com\nFeedback-ID: campaign-881:brand:esp\nList-Unsubscribe: <https://u>')).category).toBe('promotions');
    expect(classifyHeaders(h('From: Weekly <weekly@example.org>\nList-Unsubscribe: <https://u>\nPrecedence: bulk')).reason).toMatch(/bulk mail/);
  });
  it('Updates: auto-generated, no-reply senders, trackers, transactional services and receipts with List-Unsubscribe', () => {
    expect(classifyHeaders(h('From: Calendar <calendar-notification@google.com>\nSubject: Invitation: Design review')).category).toBe('updates');
    expect(classifyHeaders(h('From: Bank <alerts@bank.test>\nAuto-Submitted: auto-generated')).reason).toBe('Auto-Submitted: auto-generated');
    expect(classifyHeaders(h('From: Shop <no-reply@shop.test>\nSubject: Your receipt')).reason).toMatch(/automated sender/);
    expect(classifyHeaders(h('From: Jira <jira@acme.atlassian.net>\nX-JIRA-FingerPrint: abc')).reason).toBe('issue tracker notification');
    expect(classifyHeaders(h('From: App <hello@app.test>\nX-SES-Outgoing: 1')).category).toBe('updates');
    expect(classifyHeaders(h('From: Store <hello@store.test>\nSubject: Your order has shipped\nList-Unsubscribe: <https://u>')).category).toBe('updates');
  });
  it('a vacation auto-reply from a person stays in Primary', () => expect(classifyHeaders(h('From: Bob <bob@acme.test>\nAuto-Submitted: auto-replied\nSubject: Out of office')).category).toBe('primary'));
});

describe('classify', () => {
  it("the user's choice for a sender wins over the headers", () => {
    const overrides = new Map<string, Category>([['invitations@linkedin.com', 'primary'], ['hello@outdoorshop.com', 'updates']]);
    expect(classify(LINKEDIN, overrides)).toEqual({ category: 'primary', reason: 'you moved mail from invitations@linkedin.com here' });
    expect(classify(MAILCHIMP, overrides).category).toBe('updates');
    expect(classify(COLLEAGUE, overrides).category).toBe('primary');
  });
});

describe('helpers', () => {
  it('parses folded and repeated headers', () => {
    const p = parseHeaders('List-Unsubscribe: <a>,\r\n <b>\r\nReceived: one\r\nreceived: two\r\n');
    expect(p.get('list-unsubscribe')).toBe('<a>, <b>');
    expect(p.get('received')).toBe('one, two');
  });
  it('reads the address from From-like values', () => {
    expect(addressOf('"Ann, Lee" <Ann@Example.com>')).toBe('ann@example.com');
    expect(addressOf('ann@example.com')).toBe('ann@example.com');
    expect(addressOf('')).toBe('');
  });
  it('a tab that is off sends its mail to Primary', () => {
    expect(effective('social', ['promotions'])).toBe('primary');
    expect(effective('promotions', ['promotions'])).toBe('promotions');
    expect(effective('primary', ['promotions'])).toBe('primary');
  });
  it('normalizes the tab list', () => expect(normalizeTabs(['forums', 'social', 'social', 'nope'])).toEqual(['social', 'forums']));
});

describe('gmailQuery', () => {
  const none = new Map<string, Category>();
  it("asks Gmail for its own category, and Primary is INBOX less the enabled tabs", () => {
    expect(gmailQuery('promotions', ['promotions', 'social'], none)).toBe('category:promotions');
    expect(gmailQuery('primary', ['promotions', 'social'], none)).toBe('-category:promotions -category:social');
  });
  it("applies the user's senders: moved away, and moved here", () => {
    const o = new Map<string, Category>([['deals@shop.com', 'primary'], ['friend@x.com', 'promotions'], ['bot@y.com', 'forums']]);
    expect(gmailQuery('promotions', ['promotions', 'social'], o)).toBe('(category:promotions -from:deals@shop.com -from:bot@y.com) OR (from:friend@x.com)');
    // Forums is off, so bot@y.com's mail falls into Primary.
    expect(gmailQuery('primary', ['promotions', 'social'], o)).toBe('(-category:promotions -category:social -from:friend@x.com) OR (from:deals@shop.com) OR (from:bot@y.com)');
  });
});
