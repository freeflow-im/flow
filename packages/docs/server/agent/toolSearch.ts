// Deferred tools: the assistant's model sees only a small set of tools at the start of a turn, and finds the rest with
// its provider's tool search, which loads a tool's definition when a search matches it. Every definition is still sent
// with each request (the provider searches them), but only the loaded ones count against the context. Claude runs the
// search on Anthropic's side (tool_search_tool_bm25); OpenAI runs its own (`tool_search`, openai.ts translates), and
// OpenRouter its own (`openrouter:tool_search`, openrouter.ts translates).
import type Anthropic from '@anthropic-ai/sdk';
import type { AgentContext } from '../../shared/agent/protocol.ts';

type Tool = Anthropic.Beta.BetaToolUnion;

/** Claude's tool search, by natural-language query. Never deferred itself. */
export const TOOL_SEARCH_NAME = 'tool_search_tool_bm25';
export const TOOL_SEARCH: Tool = { type: 'tool_search_tool_bm25_20251119', name: TOOL_SEARCH_NAME };

/** Loaded on every page: finding and opening files. */
const ALWAYS = ['list_files', 'open_file', 'find_files'];

/**
 * Loaded on each page, beside ALWAYS: the tools a turn there almost always starts with, so the model does not search
 * before its first step. Each chat belongs to one page (its file's kind), so a chat's loaded set stays the same and its
 * cached prefix holds. Everything else is found by search.
 */
const CORE_BY_PAGE: Record<string, readonly string[]> = {
  sheet: ['get_sheet_overview', 'read_range', 'write_range', 'format_range'],
  deck: ['read_deck', 'add_slides', 'update_slide', 'render_slide'],
  doc: ['read_doc', 'insert_content', 'replace_blocks', 'replace_text'],
  markdown: ['read_doc', 'insert_content', 'replace_blocks', 'replace_text'],
  file: ['read_file', 'view_image'],
  mail: ['search_mail', 'read_mail', 'create_mail_draft', 'open_mail_message'],
  calendar: ['list_events', 'get_event', 'find_free_time', 'create_event', 'open_calendar_event'],
  chat: ['list_channels', 'read_messages', 'send_message'],
};

/** The tools loaded up front on this page. */
export function coreTools(context: AgentContext | undefined): ReadonlySet<string> {
  return new Set([...ALWAYS, ...(CORE_BY_PAGE[context?.page ?? ''] ?? [])]);
}

/**
 * The turn's tools with all but the page's core deferred, and the search tool first (it stays loaded, which the API
 * requires of at least one tool). A list too short to be worth deferring is returned as it is.
 */
export function deferTools(tools: Tool[], context: AgentContext | undefined): Tool[] {
  const core = coreTools(context);
  if (tools.length < 10) return tools;
  return [TOOL_SEARCH, ...tools.map((t) => ('input_schema' in t && !core.has(t.name) ? { ...t, defer_loading: true } : t))];
}

/** What the system prompt says when tools are deferred. */
export const TOOL_SEARCH_PROMPT =
  'Only some of your tools are loaded at the start. The others (for documents, presentations, spreadsheets, stored files and PDFs, pictures, the web, and the other apps the user has, such as mail, calendars and contacts) are found with the tool search tool: describe the task in a few words, such as "add a chart" or "create a calendar event", and the tools that match load for you to call. Search before you tell the user something cannot be done, and search again with other words if the first search finds nothing that fits.';

/** The tool names earlier searches in this conversation loaded (Claude's tool_search_tool_result blocks, OpenRouter's own). */
export function referencedTools(messages: Anthropic.Beta.BetaMessageParam[]): Set<string> {
  const names = new Set<string>();
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    for (const b of m.content as { type: string; content?: unknown }[]) {
      if (b.type === 'tool_search_tool_result') {
        const c = b.content as { tool_references?: { tool_name: string }[] };
        for (const r of c.tool_references ?? []) names.add(r.tool_name);
      } else if (b.type === 'openrouter_tool_search_result') {
        // OpenRouter's: { matches: [{ tool_id, schema_digest }] }.
        const c = b.content as { matches?: { tool_id: string }[] } | undefined;
        for (const r of c?.matches ?? []) names.add(r.tool_id);
      }
    }
  }
  return names;
}

/**
 * The tools with a deferred stand-in for each tool an earlier search loaded that this turn does not offer (a tool of
 * another app, the browser extension's tools in a browser without it). The API refuses a request whose history refers to
 * a tool it was not given; the stand-in keeps the history valid, and a call to it is refused as an unknown tool. Added
 * last and deferred, they leave the cached prefix as it was.
 */
export function keepReferencedTools(tools: Tool[], messages: Anthropic.Beta.BetaMessageParam[]): Tool[] {
  const offered = new Set(tools.flatMap((t) => ('name' in t ? [t.name] : [])));
  const missing = [...referencedTools(messages)].filter((n) => !offered.has(n));
  if (!missing.length) return tools;
  return [...tools, ...missing.map((name): Tool => ({ name, description: 'Not available here.', input_schema: { type: 'object', properties: {} }, defer_loading: true }))];
}

/**
 * The searches still open at the end of the conversation: Claude called the tool search beside one of our tools, so the
 * API holds the search until the tool results come back (in a message of tool results only), and runs it then.
 */
export function openSearches(messages: Anthropic.Beta.BetaMessageParam[]): string[] {
  const last = messages.at(-1);
  if (last?.role !== 'assistant' || typeof last.content === 'string') return [];
  const answered = new Set(last.content.flatMap((b) => (b.type === 'tool_search_tool_result' ? [b.tool_use_id] : [])));
  return last.content.flatMap((b) => (b.type === 'server_tool_use' && b.name === TOOL_SEARCH_NAME && !answered.has(b.id) ? [b.id] : []));
}

/**
 * An assistant message that closes open searches without running them, for when the user writes before the turn
 * finished: the API refuses new text after tool results while a search is open, so the results go in a message of their
 * own, then this, then the user's message.
 */
export const closeSearches = (ids: string[]): Anthropic.Beta.BetaMessageParam => ({
  role: 'assistant',
  content: ids.map((id) => ({ type: 'tool_search_tool_result', tool_use_id: id, content: { type: 'tool_search_tool_result_error', error_code: 'unavailable' } }) as Anthropic.Beta.BetaContentBlockParam),
});

