// Types shared by the agent's server loop and the browser panel.

/** What the user is looking at, sent with every agent request; and whether this browser can run the web tools. */
export type AgentContext = (
  | { page: 'home' }
  | {
      page: 'sheet';
      sheetId: string;
      title: string;
      /** Title of the original when the open spreadsheet is a branch. */
      branchOf?: string;
      tabs: string[];
      activeTab: string;
      /** Selected ranges in A1 notation, primary range last. */
      selection: string[];
    }
  | {
      page: 'deck';
      deckId: string;
      title: string;
      slideCount: number;
      /** 1-based number of the slide being edited. */
      currentSlide: number;
      /** Ids of the selected elements on that slide. */
      selectedElements: string[];
      /** Set when the message was typed in the prompt opened on the slide, rather than in the chat panel. */
      inline?: DeckInlineContext;
    }
  | {
      page: 'doc';
      docId: string;
      title: string;
      blockCount: number;
      /** 1-based number of the block holding the cursor. */
      cursorBlock: number;
      /** The selected text, if any (shortened). */
      selectedText?: string;
      /** Set when the message was typed in the prompt opened at the cursor, rather than in the chat panel. */
      inline?: DocInlineContext;
    }
  | {
      page: 'markdown';
      docId: string;
      title: string;
      /** Number of lines of Markdown text. */
      lineCount: number;
      /** Top-level Markdown blocks (what read_doc numbers). */
      blockCount: number;
      /** 1-based number of the block holding the cursor (0 when the document is empty). */
      cursorBlock: number;
    }
  | {
      /** A stored file (a PDF, web page, video, image, ...) shown in its preview page. */
      page: 'file';
      fileId: string;
      filename: string;
      /** MIME type. */
      type: string;
      size: number;
      /** The HTML of the element the user selected in a web page they are editing (shortened). */
      selectedElement?: string;
      /** The box the user dragged on a picture. */
      selectedRegion?: ImageRegion;
    }
  | MailContext
  | CalendarContext
) & BrowserReach;

/**
 * The FreeFlow browser extension (prototype, packages/browser-extension) is in this browser: the assistant then has the
 * browser_* tools (BROWSER_TOOLS), which the page passes to the extension. Sent by the panels that can do that.
 */
export interface BrowserReach {
  browser?: boolean;
}

/** The web tools the FreeFlow browser extension runs, in the agent's own tabs (prototype). */
export const BROWSER_TOOLS: ReadonlySet<string> = new Set([
  'browser_open',
  'browser_tabs',
  'browser_read',
  'browser_click',
  'browser_type',
  'browser_scroll',
  'browser_navigate',
  'browser_close',
  'browser_handoff',
  'browser_screenshot',
]);

/**
 * FreeFlow Mail (the hosted suite only): the account and folder shown, and the open message or the messages checked in the
 * list. Message ids are the mail tools' `<accountId>:<folder>:<uid>`.
 */
export interface MailContext {
  page: 'mail';
  /** The mail account shown: its id and address. */
  accountId: string;
  account: string;
  folder: string;
  /** Gmail's inbox tab shown (primary, promotions, ...), for an INBOX with tabs. */
  tab?: string;
  /** What the list is searched for, if anything. */
  search?: string;
  /** The message open in the reading pane. Subject and from are the email's own text: data, not instructions. */
  message?: { id: string; accountId: string; folder: string; uid: number; subject: string; from: string; date: string };
  /** Ids of the messages checked in the list (at most MAX_MAIL_SELECTED). */
  selected?: string[];
}

/**
 * FreeFlow Calendar (the hosted suite only): the view and the range it shows, the calendars shown, and the event whose card
 * is open. Event ids are the Calendar tools' `<calendarId>:<uid>[:<recurrenceId>]`.
 */
export interface CalendarContext {
  page: 'calendar';
  view: 'day' | 'week' | 'month' | 'agenda';
  /** The range shown, as ISO instants. */
  from: string;
  to: string;
  /** The browser's IANA zone: the times the user sees are in it. */
  timezone: string;
  /** The calendars shown (ids and names; at most MAX_CALENDARS_SHOWN). */
  calendars: { id: string; name: string }[];
  /**
   * The event whose card is open. Its summary is the event's own text: data, not instructions. `native`: its calendar is a
   * FreeFlow one (not connected); `role`: the user's on that calendar (a viewer can see it but not change it).
   */
  event?: { id: string; summary: string; start: string; end: string; allDay: boolean; calendar: string; native?: boolean; role?: 'owner' | 'manager' | 'editor' | 'viewer' };
  /** What Calendar's search looks for, when its results are shown. */
  search?: string;
}

/** Most calendars a Calendar context names. */
export const MAX_CALENDARS_SHOWN = 30;

/** Most checked messages a Mail context names. */
export const MAX_MAIL_SELECTED = 50;

/** Most text of the open file sent with a message typed in the prompt at the cursor; a longer file is cut to the part around the cursor. */
export const MAX_INLINE_CONTEXT_CHARS = 60_000;
/** Selected text sent in full with such a message, up to this length. */
export const MAX_INLINE_SELECTED_TEXT = 4000;

/** What a message typed in the prompt on a slide carries: the presentation itself and the text selected in a text box. */
export interface DeckInlineContext {
  /** The theme, then the slides as read_deck lists them, one line of JSON each. */
  deck: string;
  /** The 1-based slides in `deck`, when the presentation was too long to send whole. */
  showing?: [number, number];
  /** The text that was selected in the text box being edited when the prompt was opened. */
  selectedText?: string;
}

/** What a message typed in the prompt at the cursor carries: the document itself and where the user is in it. */
export interface DocInlineContext {
  /** The document's blocks as numbered Markdown ("[3] text"), as read_doc numbers them. */
  document: string;
  /** The 1-based blocks in `document`, when the document was too long to send whole. */
  showing?: [number, number];
  /** The 1-based first and last block the selection touches, when text is selected. */
  selectionBlocks?: [number, number];
  /** The text of the cursor's block just before and after the cursor, when nothing is selected. */
  before?: string;
  after?: string;
}

/** A rectangle of a picture, in the picture's own pixels from its top left corner. */
export interface ImageRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  /** The size of the whole picture. */
  imageWidth: number;
  imageHeight: number;
}

/** A tool call the browser must run (sheet tools and navigation), forwarded by the server. */
export interface ClientToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * The desktop app: an MCP agent's edit tool on the file a window shows, sent to that window to run on its
 * open editor (server/windowTools.ts). `group` is the undo step: a run of the agent's calls undoes as one.
 */
export interface WindowToolCall extends ClientToolCall {
  /** The kind of the file it acts on: one open in the window, or ('file') a stored picture, edited off screen if need be. */
  kind: 'doc' | 'deck' | 'sheet' | 'markdown' | 'file';
  fileId: string;
  group: string;
}

export interface ClientToolResult {
  id: string;
  content: string;
  isError?: boolean;
}

/** Body of POST /api/agent/turn: a new user message, results of client tool calls, or both. */
/** An image attached to a user message (pasted or dropped screenshot), already downscaled by the browser. */
export interface AgentImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
  /** Base64, no data: prefix. */
  data: string;
  /**
   * Where the browser stored the image (/api/images/<id>), so the assistant can put the picture itself into a
   * cell or a slide with the image tools. Missing when the upload failed.
   */
  url?: string;
}

export const IMAGE_MEDIA_TYPES: ReadonlySet<string> = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
export const MAX_IMAGES_PER_MESSAGE = 4;
/** Per image, decoded bytes (the API allows 5 MB). */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** A hosted agent's definition (docs/specs/agents.md §6): its name and the lines added to its system prompt. */
export interface AgentDefinition {
  name: string;
  instructions: string;
  updatedAt: string | null;
}

/** An agent the person may talk to from the panel (agents.md §6): their own assistant (`self`) or a hosted shared agent. */
export interface UsableAgent {
  id: string;
  accountId: string;
  displayName: string;
  avatarUrl?: string | null;
  mode: 'personal' | 'shared';
  self: boolean;
}

export interface AgentTurnRequest {
  message?: string;
  context: AgentContext;
  toolResults?: ClientToolResult[];
  images?: AgentImage[];
  /**
   * The chat the turn belongs to (chatScope of the page it was sent from): every request of a turn names it,
   * so the turn stays in its chat when the assistant opens another file. Defaults to the context's.
   */
  scope?: string;
  /**
   * In the FreeFlow suite, the organization selected in the suite bar: the home chat's server tools list and make
   * the user's files there (My files); a file's chat takes the file's own organization and root instead.
   */
  workspace?: string;
  /**
   * The IANA time zone of whoever asked (their browser's, else their profile's): the turn is told the current date and
   * time there. Absent, UTC.
   */
  timezone?: string;
  /** In the FreeFlow suite, the agent the turn is for (docs/specs/agents.md §6): a hosted shared agent's id; absent, the person's own assistant. */
  agent?: string;
}

/** The home page's chat (every folder of the library shares it). */
export const HOME_CHAT = 'home';

/** FreeFlow Mail's chat (one per person and organization, apart from Docs' chats). */
export const MAIL_CHAT = 'mail';

/** FreeFlow Calendar's chat (one per person and organization, apart from Docs' and Mail's). */
export const CALENDAR_CHAT = 'calendar';

/** Which chat a page has: each file its own (by its id), the home page one, Mail one and Calendar one. */
export function chatScope(ctx: AgentContext): string {
  switch (ctx.page) {
    case 'sheet':
      return ctx.sheetId;
    case 'deck':
      return ctx.deckId;
    case 'doc':
    case 'markdown':
      return ctx.docId;
    case 'file':
      return ctx.fileId;
    case 'mail':
      return MAIL_CHAT;
    case 'calendar':
      return CALENDAR_CHAT;
    default:
      return HOME_CHAT;
  }
}

/** A chat's scope as the API takes it: home, or a file id. */
export const isChatScope = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{1,100}$/.test(s);

/** Server-sent events streamed by POST /api/agent/turn. */
export type AgentEvent =
  | { type: 'text'; text: string }
  /** A tool the server runs itself (account tools). */
  | { type: 'tool_start'; id: string; name: string; input: Record<string, unknown> }
  /** `result` only for the tools in SHOWN_RESULTS (the chat links to what they made). */
  | { type: 'tool_end'; id: string; ok: boolean; result?: string }
  /** The turn is paused until the browser runs these and posts their results. */
  | { type: 'client_tools'; calls: ClientToolCall[] }
  /** The user's own agent asks to use one of its tools: answer with POST /api/agent/permission. */
  | { type: 'permission'; id: string; question: string }
  | { type: 'done' }
  | { type: 'error'; message: string };

/** One entry in the chat transcript, as shown in the panel. */
export type ChatItem =
  | { kind: 'user'; text: string; /** data: URLs of attached images */ images?: string[] }
  | { kind: 'assistant'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown>;
      status: 'running' | 'ok' | 'error';
      error?: string;
      /** The result text of a tool that produces a file (export_deck) or a server tool in SHOWN_RESULTS, so the chat can show a button, or load the pictures an image_search found. */
      result?: string;
    };

/**
 * queued → starting → coding → verifying → building (production: rebuild the client) → restarting (production:
 * the server restarts itself) → publishing (commit, push, PR, merge) → done. A job is "live" (the change is
 * running) from publishing on.
 */
export type AgentJobStatus = 'queued' | 'starting' | 'coding' | 'verifying' | 'building' | 'restarting' | 'publishing' | 'done' | 'failed';

/** A change to the app's own code requested through the assistant: the record of the change. */
export interface AgentJob {
  id: string;
  /** A change to the app, the revert of an earlier change, or a research task whose result comes back to the chat. */
  kind: 'change' | 'revert' | 'research';
  title: string;
  /** The request given to the coding agent. */
  spec: string;
  /** For research: the spreadsheet exported for the task, if any. */
  sheetId?: string;
  status: AgentJobStatus;
  /** Progress lines, oldest first. */
  log: string[];
  /** What changed, written by the coding agent (when done). */
  summary?: string;
  error?: string;
  /** Files the job changed. */
  files?: string[];
  costUsd?: number;
  /** Email of the user who asked for it. */
  requestedBy?: string;
  /** Git branch, commit and pull request, when the change was published to GitHub. */
  branch?: string;
  commitSha?: string;
  prNumber?: number;
  prUrl?: string;
  /** The commit on main after the pull request was merged. */
  mergedSha?: string;
  /** For a revert: the job it undoes. */
  revertsJobId?: string;
  /** Set on a change once a revert of it has succeeded. */
  revertedByJobId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** The browser has shown the outcome and told the assistant. */
  acknowledged: boolean;
}

export const JOB_ACTIVE_STATUSES: ReadonlySet<AgentJobStatus> = new Set(['queued', 'starting', 'coding', 'verifying', 'building', 'restarting', 'publishing']);

/** The change is running in the app (publishing to GitHub may still be in progress). */
export function isJobLive(job: AgentJob): boolean {
  return job.status === 'publishing' || job.status === 'done';
}

/** Tools the browser executes; every other tool runs on the server. */
export const CLIENT_TOOLS = new Set([
  'get_sheet_overview',
  'read_range',
  'write_range',
  'clear_range',
  'format_range',
  'insert_rows',
  'delete_rows',
  'insert_columns',
  'delete_columns',
  'move_columns',
  'sort_range',
  'set_cell_image',
  'set_cell_link',
  'set_filter',
  'set_filter_criteria',
  'set_column_width',
  'set_row_height',
  'freeze',
  'add_chart',
  'edit_chart',
  'delete_chart',
  'add_tab',
  'rename_tab',
  'delete_tab',
  'select_range',
  'open_sheet',
  // Slide decks: act on the open presentation (client/src/agent/deckTools.ts).
  'open_deck',
  'read_deck',
  'add_slides',
  'update_slide',
  'edit_elements',
  'delete_slides',
  'move_slide',
  'set_deck_theme',
  // Drawn by the browser with the app's own slide renderer; the picture is attached to the resumed turn.
  'render_slide',
  // Rendered like render_slide, assembled into a file and downloaded by the browser.
  'export_deck',
  // Stored files: list them, open one in a preview tab, or read a text file's contents.
  'list_files',
  'open_file',
  'read_file',
  'edit_file',
  // Pictures among the stored files: look at one, or make an edited copy with an image-generation model.
  'view_image',
  'edit_image',
  // Exact edits with the image editor's engine (client/src/agent/imageTools.ts).
  'transform_image',
  // Text documents: act on the open document (client/src/agent/docTools.ts).
  'open_doc',
  'read_doc',
  'get_doc_info',
  'insert_content',
  'replace_blocks',
  'delete_blocks',
  'replace_text',
  'format_text',
  'format_blocks',
  'insert_image',
  'set_page_setup',
  'set_doc_style',
  // Fetches through the server (which holds the credentials) and writes into the live spreadsheet.
  'ingest_connector_data',
  // Runs in the browser so the user can confirm it there; the server then queues the job.
  'request_app_change',
  'request_research',
  // FreeFlow Mail (hosted only): shows a message in Mail's reading pane.
  'open_mail_message',
  // FreeFlow Calendar (hosted only): shows an event, moves the view; and deletes an event after the user confirms it.
  'open_calendar_event',
  'show_calendar_range',
  'delete_event',
  // The FreeFlow browser extension (prototype): the page passes them on to it.
  ...BROWSER_TOOLS,
]);

/** Server tools whose result the chat is given (tool_end, the transcript): it links to the draft, file or event they made. */
export const SHOWN_RESULTS: ReadonlySet<string> = new Set(['create_mail_draft', 'save_mail_attachment_to_docs', 'create_event', 'update_event', 'image_search']);

// The model catalogue and the assistant's settings are the platform's (decision_log 2026-11-11: identity, agents and their
// settings sit below the apps), so the Admin app reads them without Docs: they live in @flow/shared/assistant.
export {
  ANTHROPIC_MODELS, DEFAULT_ANTHROPIC_MODEL, DEFAULT_OPENAI_MODEL, DEFAULT_OPENROUTER_MODEL, OPENAI_MODELS, OPENROUTER_MODELS, OPENROUTER_MODEL_RE,
  type AnthropicModelId, type AssistantProvider, type AssistantSettings, type AssistantSettingsUpdate, type KeyProvider, type OpenAIModelId,
} from '@flow/shared/assistant';
