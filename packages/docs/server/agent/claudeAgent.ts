// The assistant panel run by the user's own Claude Code (the 'claude-agent' choice in Settings, desktop app
// only): each turn is a Claude Agent SDK query on the `claude` they have installed and signed in to, in the
// open folder, resuming the conversation's session. It has all of Claude Code's own tools, and the app's MCP
// server (the plugin's tools, server/localMcp.ts) with this server's own token, whose edits on the file open
// in the window run there (server/windowTools.ts): undoable, one undo step per turn. Its text and tool calls
// stream to the panel as the built-in loop's do, and are kept in the conversation for the transcript. It runs
// in Claude Code's auto permission mode: its classifier approves routine tool use, and a permission it cannot
// decide is asked in the panel (AgentEvent 'permission').
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { AgentEvent, AgentTurnRequest } from '../../shared/agent/protocol.ts';
import { renderContext } from './prompt.ts';
import type { AgentStore, Conversation, MessageParam } from './store.ts';

/** The app's MCP server, as the agent knows it: its tools are `mcp__mcp-docs-app__<name>`. */
export const APP_SERVER = 'mcp-docs-app';
const APP_TOOL_PREFIX = `mcp__${APP_SERVER}__`;
/** The same server through the user's mcp-docs plugin (OAuth, the fixed port): left out, as a duplicate. */
const PLUGIN_SERVER = 'mcp__plugin_mcp-docs_mcp-docs';

const PROMPT = `You are the assistant inside MCP Docs, a desktop app for the documents, presentations, spreadsheets, Markdown files, PDFs and pictures in the folder open in it, which is your working directory. The person is talking to you in the app's assistant panel, beside the file they have open; each of their messages starts with a <context> block saying what is open and what they have selected ("this" and "here" mean that).

Work on their files with the ${APP_SERVER} MCP tools: with no id they act on the file open in the app, and the change appears there as you make it, undoable by the person. Use them rather than editing Word, PowerPoint or Excel files (.docx, .pptx, .xlsx) on disk, which the app would not show. Read before you edit (read_doc, read_deck, get_sheet_overview), keep edits targeted, and write spreadsheet formulas rather than computed numbers. render_slide shows you a slide as it is drawn. Your own tools are there for everything else.

Reply briefly, in plain prose: the panel shows each tool call you make.`;

/** What a turn's query needs from the SDK (tests pass a stub). */
export type QueryFn = (params: { prompt: AsyncIterable<SdkUserMessage>; options: Record<string, unknown> }) => AsyncIterable<SdkMessage>;

interface SdkUserMessage {
  type: 'user';
  message: { role: 'user'; content: unknown[] };
  parent_tool_use_id: null;
  origin: { kind: 'human' };
}

/** The parts of the SDK's messages a turn reads. */
type SdkMessage =
  | { type: 'system'; subtype: string; session_id?: string }
  | { type: 'stream_event'; parent_tool_use_id: string | null; event: { type: string; delta?: { type: string; text?: string } } }
  | { type: 'assistant'; parent_tool_use_id: string | null; message: { content: Block[] } }
  | { type: 'user'; parent_tool_use_id: string | null; message: { content: string | Block[] } }
  | { type: 'result'; subtype: string; errors?: string[]; result?: string }
  | { type: string };

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean } | { type: string };

export interface ClaudeAgentOptions {
  /** The open folder, where the agent works. */
  cwd(): string;
  /** The app's own MCP endpoint and the token it takes. */
  mcp(): { url: string; token: string };
  /** Pins (and unpins, with null) the undo group of the window's edits for a turn (WindowTools.pinGroup). */
  pinGroup?(group: string | null): void;
  /** The `claude` executable; found on the user's PATH when not given. */
  executable?: string | null;
  /** The SDK's query (tests pass a stub). */
  query?: QueryFn;
}

export class AgentNotFoundError extends Error {}

/** The tool's name as the panel labels it: the app's own tools by their plain names. */
export const panelToolName = (name: string): string => (name.startsWith(APP_TOOL_PREFIX) ? name.slice(APP_TOOL_PREFIX.length) : name);

export class ClaudeAgentDriver {
  private opts: ClaudeAgentOptions;
  private found: string | null | undefined;
  /** Permission questions waiting for the user's answer, by the id sent with them. */
  private permissions = new Map<string, (allow: boolean) => void>();

  constructor(opts: ClaudeAgentOptions) {
    this.opts = opts;
    this.found = opts.executable;
  }

  /** The user's answer to a permission question; false when there is no such question (any more). */
  answerPermission(id: string, allow: boolean): boolean {
    const answer = this.permissions.get(id);
    if (!answer) return false;
    this.permissions.delete(id);
    answer(allow);
    return true;
  }

  async run(conv: Conversation, store: AgentStore, req: AgentTurnRequest, emit: (e: AgentEvent) => void, signal: AbortSignal): Promise<void> {
    const executable = this.executable();
    const text = req.message?.trim() ?? '';
    const images = req.images ?? [];
    const context = renderContext(req.context);
    // The message as the transcript keeps it (the context is hidden there, as for the built-in loop).
    const content: unknown[] = [{ type: 'text', text: context }];
    for (const img of images) content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data } });
    const stored = images.map((img, i) => (img.url ? `Attached image ${i + 1} is stored at ${img.url}; use that address with the image tools to put the picture itself in a cell or on a slide.` : null)).filter((s): s is string => !!s);
    if (stored.length) content.push({ type: 'text', text: `<attached_images>\n${stored.join('\n')}\n</attached_images>` });
    content.push({ type: 'text', text: text || 'See the attached image.' });
    store.append(conv.id, { role: 'user', content } as MessageParam);

    const query = this.opts.query ?? ((await import('@anthropic-ai/claude-agent-sdk')).query as unknown as QueryFn);
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    signal.addEventListener('abort', onAbort);
    const mcp = this.opts.mcp();
    this.opts.pinGroup?.(`agent-${Date.now()}`);
    try {
      const messages = query({
        prompt: (async function* () {
          yield { type: 'user', message: { role: 'user', content }, parent_tool_use_id: null, origin: { kind: 'human' } } satisfies SdkUserMessage;
        })(),
        options: {
          cwd: this.opts.cwd(),
          pathToClaudeCodeExecutable: executable,
          ...(conv.sessionId ? { resume: conv.sessionId } : {}),
          abortController: abort,
          includePartialMessages: true,
          systemPrompt: { type: 'preset', preset: 'claude_code', append: PROMPT },
          mcpServers: { [APP_SERVER]: { type: 'http', url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } },
          disallowedTools: [PLUGIN_SERVER],
          // Claude Code's classifier approves routine tool use; only what it cannot decide is asked in the panel.
          permissionMode: 'auto',
          canUseTool: (name: string, input: Record<string, unknown>, o: { signal: AbortSignal; title?: string; description?: string; displayName?: string }) => this.permit(name, input, o, emit),
        },
      });
      let finished = false;
      for await (const m of messages) {
        if (signal.aborted) break;
        if (m.type === 'system' && 'session_id' in m && m.session_id && (m as { subtype: string }).subtype === 'init' && m.session_id !== conv.sessionId) {
          store.setSession(conv.id, m.session_id);
          conv.sessionId = m.session_id;
        } else if (m.type === 'stream_event' && 'event' in m && m.parent_tool_use_id === null) {
          // The agent's words as they come; its subagents' are not the conversation.
          if (m.event.type === 'content_block_delta' && m.event.delta?.type === 'text_delta' && m.event.delta.text) emit({ type: 'text', text: m.event.delta.text });
        } else if (m.type === 'assistant' && 'message' in m && m.parent_tool_use_id === null) {
          const blocks: Block[] = [];
          for (const b of m.message.content) {
            if (b.type === 'text' && 'text' in b) blocks.push({ type: 'text', text: b.text });
            else if (b.type === 'tool_use' && 'id' in b) {
              const tool = { type: 'tool_use' as const, id: b.id, name: panelToolName(b.name), input: (b.input ?? {}) as Record<string, unknown> };
              blocks.push(tool);
              emit({ type: 'tool_start', id: tool.id, name: tool.name, input: tool.input });
            }
          }
          if (blocks.length) store.append(conv.id, { role: 'assistant', content: blocks } as MessageParam);
        } else if (m.type === 'user' && 'message' in m && m.parent_tool_use_id === null && Array.isArray(m.message.content)) {
          const results: Block[] = [];
          for (const b of m.message.content) {
            if (b.type !== 'tool_result' || !('tool_use_id' in b)) continue;
            results.push({ type: 'tool_result', tool_use_id: b.tool_use_id, content: resultText(b.content), ...(b.is_error ? { is_error: true } : {}) });
            emit({ type: 'tool_end', id: b.tool_use_id, ok: !b.is_error });
          }
          if (results.length) store.append(conv.id, { role: 'user', content: results } as MessageParam);
        } else if (m.type === 'result' && 'subtype' in m) {
          finished = true;
          if (m.subtype === 'success') emit({ type: 'done' });
          else emit({ type: 'error', message: (m.errors ?? []).join('\n') || `Claude Code stopped (${m.subtype.replace(/_/g, ' ')}).` });
        }
      }
      if (!finished && !signal.aborted) emit({ type: 'done' });
    } finally {
      signal.removeEventListener('abort', onAbort);
      this.opts.pinGroup?.(null);
      // Questions left unanswered (the turn was stopped) are answered no.
      for (const [id, answer] of this.permissions) {
        this.permissions.delete(id);
        answer(false);
      }
    }
  }

  /** Whether the agent may use a tool: the app's own tools always (the window asks about destructive changes), anything else as the user says. */
  private async permit(name: string, input: Record<string, unknown>, o: { signal: AbortSignal; title?: string; description?: string; displayName?: string }, emit: (e: AgentEvent) => void) {
    if (name.startsWith(APP_TOOL_PREFIX)) return { behavior: 'allow' as const, updatedInput: input };
    const id = randomUUID();
    const question = [o.title ?? `Claude wants to use ${o.displayName ?? name}.`, o.description].filter(Boolean).join('\n\n');
    const allow = await new Promise<boolean>((resolve) => {
      this.permissions.set(id, resolve);
      o.signal.addEventListener('abort', () => this.answerPermission(id, false), { once: true });
      emit({ type: 'permission', id, question });
    });
    return allow ? { behavior: 'allow' as const, updatedInput: input } : { behavior: 'deny' as const, message: 'The user did not allow this.' };
  }

  /** The user's `claude`: the configured one, else the one on their login shell's PATH, else where installers put it. */
  private executable(): string {
    if (this.found === undefined) this.found = findClaude();
    if (!this.found) throw new AgentNotFoundError('Claude Code was not found on this Mac. Install it (claude.com/claude-code) and sign in, or choose another assistant in Settings.');
    return this.found;
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text) : '')).join('');
  return '';
}

const runnable = (p: string): boolean => {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/**
 * Where the user's `claude` is. The app is started from Finder without the login shell's PATH, so the shell
 * is asked; then the places the installers use.
 */
export function findClaude(): string | null {
  const configured = process.env.CLAUDE_CODE_PATH?.trim();
  if (configured && runnable(configured)) return configured;
  const shell = process.env.SHELL || '/bin/zsh';
  const r = spawnSync(shell, ['-ilc', 'command -v claude'], { encoding: 'utf8', timeout: 5000 });
  const fromShell = r.status === 0 ? r.stdout.trim().split('\n').pop()?.trim() : undefined;
  if (fromShell && path.isAbsolute(fromShell) && runnable(fromShell)) return fromShell;
  const home = homedir();
  for (const p of [path.join(home, '.local/bin/claude'), path.join(home, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude']) if (runnable(p)) return p;
  return null;
}
