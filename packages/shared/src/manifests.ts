// The suite's apps, one manifest each (docs/specs/platform.md §6.1). The Worker's assembler (packages/edge/scripts/
// assemble.mjs), its pages (routes/pages.ts), the suite bar's tabs (@flow/suite-bar's suiteTabsFrom) and the MCP
// consent page's scope groups (directory/mcpOAuth.ts) read this list instead of each keeping its own.
import type { AppManifest } from './platform.js';

/** A preview (Mail's attachment overlay frames it) and a public link: kept out of search engines. */
const FRAMED = { 'x-frame-options': 'SAMEORIGIN', 'content-security-policy': "frame-ancestors 'self'", 'x-robots-tag': 'noindex' };
const PUBLIC = { 'referrer-policy': 'no-referrer', 'x-robots-tag': 'noindex' };

export const APP_MANIFESTS: AppManifest[] = [
  {
    name: 'chat',
    path: '/',
    scope: 'organization',
    object: { className: 'Org', migrationTag: 'v1' },
    routes: 'org',
    kinds: [{ kind: 'channel', container: true }, { kind: 'message' }, { kind: 'artifact' }, { kind: 'file' }],
    tab: { label: 'Chat', shortcut: '2', badge: 'chat-unread' },
    client: { dist: 'packages/web/dist', basePath: '/' },
    // Every other address (a channel, a thread, a settings tab): it routes in the browser. Registered last.
    pages: [{ path: '*', html: 'index.html', passFiles: true }],
    events: [
      'chat.message.created',
      'chat.message.updated',
      'chat.message.deleted',
      'chat.message.purged',
      'chat.thread.reply',
      'chat.channel.created',
      'chat.channel.updated',
      'chat.channel.archived',
      'chat.member.joined',
      'chat.member.left',
      'chat.member.updated',
      'chat.reaction.added',
      'chat.reaction.removed',
      'chat.artifact.created',
      'chat.artifact.updated',
      'chat.artifact.deleted',
      'chat.notification.created',
      'chat.notification.read',
    ],
  },
  {
    name: 'docs',
    path: '/workspace',
    scope: 'organization',
    object: { className: 'Docs', migrationTag: 'v2' },
    routes: 'docs',
    kinds: [{ kind: 'folder', container: true }, { kind: 'sheet' }, { kind: 'file' }],
    scopes: [
      {
        id: 'docs',
        label: 'Docs files',
        detail: 'Read, create, change, import, move and delete the documents, presentations, spreadsheets, PDFs and other files of the organization below: its Organization files and your own My files there.',
        readOnly: {
          label: 'Docs files (read only)',
          detail: 'See and read the documents, presentations, spreadsheets, PDFs and other files of the organization below: its Organization files and your own My files there.',
        },
        scopes: ['files:read', 'files:write'],
        checkedByDefault: true,
      },
    ],
    tab: { label: 'Docs', shortcut: '1', badge: 'none' },
    client: { dist: 'packages/docs/dist/client', basePath: '/workspace/' },
    pages: [
      { path: '/workspace', html: 'workspace.html', signIn: true },
      { path: '/workspace/p/*', html: 'workspace.html', headers: PUBLIC },
      { path: '/workspace/preview/*', html: 'workspace.html', headers: FRAMED },
      { path: '/workspace/*', html: 'workspace.html', passFiles: true },
    ],
    events: ['docs.file.changed'],
  },
  {
    name: 'mail',
    path: '/mail',
    scope: 'account',
    object: { className: 'Mail', migrationTag: 'v4' },
    routes: 'mail',
    kinds: [{ kind: 'message' }],
    scopes: [
      {
        id: 'mail',
        label: 'Mail: read, search, organise and draft',
        detail: 'Your own email accounts in FreeFlow Mail: search and read messages and attachments, mark, move, archive and move them to Trash, and write drafts for you to review. It cannot send them.',
        readOnly: { label: 'Mail: read and search', detail: 'Your own email accounts in FreeFlow Mail: search and read messages and attachments.' },
        scopes: ['mail:read', 'mail:write'],
        checkedByDefault: true,
      },
      {
        // Off unless the person ticks it: an agent drafts, and the person sends.
        id: 'send',
        label: 'Send email as you',
        detail: 'Send messages from your email accounts.',
        warning: 'It could send any email to anyone from your address, without asking you first. Only allow this for an agent you trust.',
        scopes: ['mail:send'],
        checkedByDefault: false,
      },
    ],
    tab: { label: 'Mail', shortcut: '3', badge: 'mail-unread' },
    client: { dist: 'packages/mail/dist', basePath: '/mail/', optional: true },
    pages: [
      { path: '/mail', html: 'mail.html', signIn: true },
      { path: '/mail/*', html: 'mail.html', signIn: true, passFiles: true },
    ],
    events: ['mail.received'],
  },
  {
    name: 'calendar',
    path: '/calendar',
    scope: 'account',
    object: { className: 'Calendar', migrationTag: 'v5' },
    routes: 'calendar',
    kinds: [{ kind: 'calendar', container: true }, { kind: 'event' }],
    scopes: [
      {
        id: 'calendar',
        label: 'Calendar: see and change your events',
        detail: 'Your own calendars in FreeFlow Calendar: see your events and when you are free, create, move and delete events, invite people and answer invitations.',
        readOnly: { label: 'Calendar: see your events', detail: 'Your own calendars in FreeFlow Calendar: see your events and when you are free.' },
        scopes: ['calendar:read', 'calendar:write'],
        checkedByDefault: true,
      },
    ],
    tab: { label: 'Calendar', shortcut: '4', badge: 'none' },
    client: { dist: 'packages/calendar/dist', basePath: '/calendar/', optional: true },
    pages: [
      { path: '/calendar', html: 'calendar.html', signIn: true },
      { path: '/calendar/*', html: 'calendar.html', signIn: true, passFiles: true },
    ],
    events: ['calendar.event.added', 'calendar.event.updated', 'calendar.event.cancelled', 'calendar.invited'],
  },
  {
    name: 'events',
    scope: 'organization',
    object: { className: 'Events', migrationTag: 'v6' },
    routes: 'events',
    kinds: [],
    scopes: [
      {
        id: 'events',
        label: 'Events: read the subscriptions you make',
        detail: 'Subscribe to what happens in the organization below (messages, mail, calendar changes) and read those subscriptions: only what you can see yourself.',
        scopes: ['events:read'],
        checkedByDefault: true,
      },
    ],
    events: [],
  },
];
