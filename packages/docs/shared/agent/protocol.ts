// Types shared by the agent's server loop and the browser panel.

/** What the user is looking at, sent with every agent request. */
export type AgentContext =
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
    };

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
}

/** The home page's chat (every folder of the library shares it). */
export const HOME_CHAT = 'home';

/** Which chat a page has: each file its own (by its id), and the home page one. */
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
  | { type: 'tool_end'; id: string; ok: boolean }
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
      /** The result text of a tool that produces a file (export_deck), so the chat can show a file button. */
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
]);

/** OpenAI models a user can run the assistant on with their own API key (Settings page). */
export const OPENAI_MODELS = [
  { id: 'gpt-6-astra', name: 'Astra', hint: 'Most capable, highest cost' },
  { id: 'gpt-6.1-sol', name: 'Sol', hint: 'Balanced' },
  { id: 'gpt-6-luna', name: 'Luna', hint: 'Fastest, lowest cost' },
] as const;
export type OpenAIModelId = (typeof OPENAI_MODELS)[number]['id'];
export const DEFAULT_OPENAI_MODEL: OpenAIModelId = 'gpt-6.1-sol';

/** Claude models a user can run the assistant on with their own Anthropic API key (Settings page). */
export const ANTHROPIC_MODELS = [
  { id: 'claude-opus-5-5', name: 'Claude Opus 5.5', hint: 'Most capable, highest cost' },
  { id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5', hint: 'Balanced' },
  { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5', hint: 'Fastest, lowest cost' },
] as const;
export type AnthropicModelId = (typeof ANTHROPIC_MODELS)[number]['id'];
export const DEFAULT_ANTHROPIC_MODEL: AnthropicModelId = 'claude-sonnet-5-5';

/**
 * Suggestions for the OpenRouter model field, which takes any OpenRouter model that can call tools: leading
 * models on OpenRouter as of October 2026 (its benchmark leaders, then the newest of each major lab).
 */
export const OPENROUTER_MODELS = [
  { id: 'anthropic/claude-opus-5.5', name: 'Claude Opus 5.5' },
  { id: 'anthropic/claude-sonnet-5.5', name: 'Claude Sonnet 5.5' },
  { id: 'anthropic/claude-fable-5.1', name: 'Claude Fable 5.1' },
  { id: 'qwen/qwen3.8-max-0902', name: 'Qwen3.8 Max' },
  { id: 'openai/gpt-6-astra', name: 'GPT-6 Astra' },
  { id: 'google/gemini-4-argon', name: 'Gemini 4 Argon' },
  { id: 'openai/gpt-6.1-sol', name: 'GPT-6.1 Sol' },
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' },
  { id: 'anthropic/claude-fable-5', name: 'Claude Fable 5' },
  { id: 'meta/muse-spark-1.3', name: 'Muse Spark 1.3' },
  { id: 'anthropic/claude-haiku-5.5', name: 'Claude Haiku 5.5' },
  { id: 'x-ai/grok-4.7', name: 'Grok 4.7' },
  { id: 'deepseek/deepseek-v4-pro-0813', name: 'DeepSeek V4 Pro' },
  { id: 'deepseek/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
  { id: 'google/gemini-3.8-flash', name: 'Gemini 3.8 Flash' },
  { id: 'openai/gpt-6-luna', name: 'GPT-6 Luna' },
  { id: 'z-ai/glm-5.3', name: 'GLM 5.3' },
  { id: 'moonshotai/kimi-k3', name: 'Kimi K3' },
  { id: 'mistralai/mistral-large-4-0', name: 'Mistral Large 4' },
  { id: 'qwen/qwen3.8-flash', name: 'Qwen3.8 Flash' },
] as const;
export const DEFAULT_OPENROUTER_MODEL = 'anthropic/claude-sonnet-5.5';
/** An OpenRouter model id: author/slug, with an optional :variant. */
export const OPENROUTER_MODEL_RE = /^[a-z0-9][\w.-]*\/[\w.-]+(:[\w.-]+)?$/i;

/**
 * What powers the assistant: 'default' is the model this server is set up with (the hosted app's); the
 * key providers run on the user's own API key. The desktop app has no model of its own, so its user brings a
 * key, or picks 'claude-agent': the Claude Code they have installed and signed in to, run through the Claude
 * Agent SDK (server/agent/claudeAgent.ts).
 */
export type AssistantProvider = 'default' | 'anthropic' | 'openai' | 'openrouter' | 'claude-agent';
/** The providers that run on the user's own API key. */
export type KeyProvider = Exclude<AssistantProvider, 'default' | 'claude-agent'>;

/** A user's choice of what powers the assistant. The keys themselves never leave the server. */
export interface AssistantSettings {
  provider: AssistantProvider;
  /** Whether this server has a model of its own ('default' can be chosen). */
  builtIn: boolean;
  /** Whether the user's own installed agent can run the assistant ('claude-agent'; the desktop app). */
  agents: boolean;
  anthropicModel: AnthropicModelId;
  openaiModel: OpenAIModelId;
  openrouterModel: string;
  /** Each saved key, masked ("••••abcd"), or null when there is none. */
  anthropicKey: string | null;
  openaiKey: string | null;
  openrouterKey: string | null;
  /** The user's Brave Search API key for web and image search, masked, or null (then the provider's own search is used). */
  braveKey: string | null;
}

/**
 * Body of PUT /api/settings/assistant. A new key replaces the saved one, null removes it, omitted keeps it;
 * an omitted model keeps the saved one.
 */
export interface AssistantSettingsUpdate {
  provider: AssistantProvider;
  anthropicModel?: AnthropicModelId;
  openaiModel?: OpenAIModelId;
  openrouterModel?: string;
  anthropicKey?: string | null;
  openaiKey?: string | null;
  openrouterKey?: string | null;
  /** A new Brave Search API key, null to remove the saved one; omitted keeps it. */
  braveKey?: string | null;
}
