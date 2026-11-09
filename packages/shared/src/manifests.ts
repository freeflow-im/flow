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
    kinds: [{ kind: 'channel', container: true, resolve: 'org' }, { kind: 'message', resolve: 'org' }, { kind: 'artifact', resolve: 'org' }, { kind: 'file', resolve: 'org' }],
    // Its tools, by name (their definitions: @flow/shared/tools, platform.md §5.4).
    tools: [
      'send_message', 'react', 'upload_file', 'search_history', 'list_channels', 'list_users', 'join_channel', 'set_channel_indicator', 'set_channel_emoji', 'leave_channel', 'create_channel', 'start_task',
      'invite_to_channel', 'set_avatar', 'create_artifact', 'deliver_artifact', 'update_artifact', 'delete_artifact', 'list_artifacts', 'read_messages', 'download_file',
    ],
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
    kinds: [{ kind: 'folder', container: true, resolve: 'app' }, { kind: 'sheet', resolve: 'app' }, { kind: 'file', resolve: 'app' }],
    // Its tools, by name (their definitions: @flow/shared/tools, platform.md §5.4).
    tools: [
      'list_files', 'search_files', 'get_profile', 'create_doc', 'create_deck', 'create_sheet', 'import_file', 'open_file', 'view_image', 'create_folder', 'move_file', 'upload_file', 'read_file',
      'edit_file', 'convert_pdf_to_markdown', 'export_pdf', 'transform_image', 'rename_file', 'delete_file', 'read_doc', 'get_doc_info', 'insert_content', 'replace_blocks', 'delete_blocks', 'replace_text',
      'format_text', 'format_blocks', 'insert_image', 'set_doc_style', 'set_page_setup', 'read_deck', 'add_slides', 'update_slide', 'edit_elements', 'delete_slides', 'move_slide', 'set_deck_theme',
      'get_sheet_overview', 'read_range', 'write_range', 'clear_range', 'format_range', 'insert_rows', 'delete_rows', 'insert_columns', 'delete_columns', 'move_columns', 'sort_range', 'set_cell_image',
      'set_cell_link', 'set_filter', 'set_filter_criteria', 'set_column_width', 'set_row_height', 'freeze', 'add_chart', 'edit_chart', 'delete_chart', 'add_tab', 'rename_tab', 'delete_tab', 'select_range',
      'open_sheet', 'open_deck', 'render_slide', 'export_deck', 'convert_pdf', 'edit_image', 'open_doc', 'request_app_change', 'request_research', 'list_sheets', 'read_other_sheet', 'list_decks',
      'list_docs', 'read_other_doc', 'list_connections', 'fetch_connector_data', 'ingest_connector_data', 'web_search', 'image_search',
    ],
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
    assistant: { pages: ['home', 'sheet', 'deck', 'doc', 'markdown', 'file'] },
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
    // Its tools, by name (their definitions: @flow/shared/tools, platform.md §5.4).
    tools: [
      'list_mail_accounts', 'list_mail_folders', 'search_mail', 'read_mail', 'save_mail_attachment_to_docs', 'mark_mail', 'move_mail', 'archive_mail', 'move_mail_to_tab', 'trash_mail', 'create_mail_draft',
      'send_mail', 'open_mail_message', 'list_mail',
    ],
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
    assistant: { pages: ['mail'] },
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
    kinds: [{ kind: 'calendar', container: true, resolve: 'app' }, { kind: 'event', resolve: 'app' }],
    // Its tools, by name (their definitions: @flow/shared/tools, platform.md §5.4).
    tools: [
      'list_calendars', 'list_shared_calendars', 'list_events', 'get_event', 'find_free_time', 'create_event', 'update_event', 'delete_event', 'respond_to_event', 'share_calendar', 'unshare_calendar',
      'open_calendar_event', 'show_calendar_range', 'list_my_events',
    ],
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
    assistant: { pages: ['calendar'] },
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
    // Its tools, by name (their definitions: @flow/shared/tools, platform.md §5.4).
    tools: [
      'list_subscriptions', 'create_subscription', 'read_events', 'ack_events', 'list_jobs',
    ],
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
  {
    // The assistant (platform.md §5.5): one object per account holding its chats, settings and usage, which runs the model
    // loop with the registry's tools; the apps above give it page context and browser tools (their `assistant`).
    name: 'assistant',
    scope: 'account',
    object: { className: 'Assistant', migrationTag: 'v7' },
    routes: 'assistant',
    kinds: [],
    events: [],
  },
  {
    // Contacts (platform.md §11, phase 6.5): the fifth app, added by this manifest. One object per account: the person's own
    // contacts, which they may share with the organization (an `org` viewer grant on their list); the routes merge in the
    // organization's members and the people they wrote to from Mail.
    name: 'contacts',
    path: '/contacts',
    scope: 'account',
    object: { className: 'Contacts', migrationTag: 'v8' },
    routes: 'contacts',
    kinds: [
      { kind: 'list', container: true, resolve: 'app', address: '/contacts/?list={id}', icon: '📇', label: 'Contacts' },
      { kind: 'contact', resolve: 'app', address: '/contacts/?contact={id}', icon: '👤', label: 'Contact' },
    ],
    // Its tools, by name (their definitions: @flow/shared/tools, platform.md §5.4).
    tools: ['list_contacts', 'find_contact', 'add_contact'],
    scopes: [
      {
        id: 'contacts',
        label: 'Contacts: see and add contacts',
        detail: 'Your contacts in FreeFlow Contacts, the members of the organization below and the people you wrote to: list and search them, and add contacts.',
        readOnly: { label: 'Contacts: see your contacts', detail: 'Your contacts in FreeFlow Contacts, the members of the organization below and the people you wrote to: list and search them.' },
        scopes: ['contacts:read', 'contacts:write'],
        checkedByDefault: true,
      },
    ],
    assistant: { pages: ['contacts'] },
    tab: { label: 'Contacts', shortcut: '5', badge: 'none' },
    client: { dist: 'packages/contacts/dist', basePath: '/contacts/', optional: true },
    pages: [
      { path: '/contacts', html: 'contacts.html', signIn: true },
      { path: '/contacts/*', html: 'contacts.html', signIn: true, passFiles: true },
    ],
    events: ['contacts.changed'],
  },
  {
    // Admin (docs/specs/workspace-admin.md §2.1): the organization's settings, an app of its own rather than a view in
    // Chat. No object and no routes: it reads and writes through the directory's routes (domains, accounts) and the Org
    // object's (the workspace, members, invitations, emoji, agents). No tab: the suite bar's organization menu opens it.
    name: 'admin',
    path: '/admin',
    scope: 'organization',
    kinds: [],
    client: { dist: 'packages/admin/dist', basePath: '/admin/', optional: true },
    pages: [
      { path: '/admin', html: 'admin.html', signIn: true },
      { path: '/admin/*', html: 'admin.html', signIn: true, passFiles: true },
    ],
    events: [],
  },
];
