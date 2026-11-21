// An agent's wakes for itself (docs/specs/agent-self-wake.md): schedule_wake, list_wakes and cancel_wake on the `flow` MCP
// server, calling /v1/events/wakes as the agent's account in the organization the bridge serves (`?workspace=`). A wake
// answers in the conversation the tool was called from (its channel, and its thread) unless it names another channel:
// when it fires, the server files a wake job, and the bridge runs it there (bridge.ts runJob). Kept apart from
// mcp-server.ts so the suite runs them against a fake server.
import type { FlowApi } from './api.js';
import { FlowApiError } from './api.js';

export const WAKE_TOOLS = [
  {
    name: 'schedule_wake',
    description:
      'Sets a one-time wake for yourself: at that time you get a new turn with prompt as your note to yourself, in this conversation (this thread, when you were asked in one), or in channelId (and threadRootId) if given. Give exactly one of at (an ISO time with its offset) or in_minutes. From 1 minute to 365 days ahead; at most 10 waiting. To check again after it fires, set a new one then. Use it for "check back in 20 minutes", "remind them on Friday at 9".',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Your note to yourself: what to do when you wake, with what you will need to know then.' },
        at: { type: 'string', description: 'When, as an ISO time with its offset: 2026-11-21T09:00:00-08:00.' },
        in_minutes: { type: 'integer', minimum: 1, maximum: 525600, description: 'Or: this many minutes from now.' },
        channelId: { type: 'string', description: 'Where to answer instead of this conversation: a channel you are in.' },
        threadRootId: { type: 'string', description: 'With channelId: the thread to answer in.' },
        name: { type: 'string', description: 'A short name for it (else the start of prompt).' },
      },
      required: ['prompt'],
    },
  },
  {
    name: 'list_wakes',
    description: 'The wakes you set for yourself that have not fired yet, soonest first: id, name, prompt, at, and where you will answer.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cancel_wake',
    description: 'Cancels one of the wakes you set for yourself, by its id from schedule_wake or list_wakes.',
    inputSchema: { type: 'object', properties: { wake_id: { type: 'string', description: 'A wake id, from schedule_wake or list_wakes.' } }, required: ['wake_id'] },
  },
];

export const WAKE_TOOL_NAMES: ReadonlySet<string> = new Set(WAKE_TOOLS.map((t) => t.name));

interface WakeView { id: string; name: string; prompt: string; at: string; channelId?: string; threadRootId?: string }

export type WakeApi = Pick<FlowApi, 'wakes'>;

const line = (w: WakeView) => `${w.id} · ${w.at} · ${w.name}${w.channelId ? ` · in ${w.channelId}${w.threadRootId ? ` (thread ${w.threadRootId})` : ''}` : ''}`;

/** One wake tool's call: its answer as text, and whether it is an error the agent should read. */
export async function wakeTool(
  api: WakeApi, workspaceId: string, name: string, args: Record<string, unknown>, here: { channelId: string; threadRootId?: string },
): Promise<{ text: string; isError: boolean }> {
  if (!workspaceId) return { text: `${name} needs a workspace (FLOW_WORKSPACE_ID is not set)`, isError: true };
  try {
    switch (name) {
      case 'schedule_wake': {
        const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
        if (!prompt) return { text: 'schedule_wake needs a prompt: your note to yourself', isError: true };
        const named = typeof args.channelId === 'string' && args.channelId.trim() ? args.channelId.trim() : '';
        const where = named
          ? { channelId: named, ...(typeof args.threadRootId === 'string' && args.threadRootId.trim() ? { threadRootId: args.threadRootId.trim() } : {}) }
          : here.channelId ? { channelId: here.channelId, ...(here.threadRootId ? { threadRootId: here.threadRootId } : {}) } : {};
        const body = {
          prompt,
          ...(typeof args.at === 'string' && args.at.trim() ? { at: args.at.trim() } : {}),
          ...(args.in_minutes !== undefined ? { inMinutes: Number(args.in_minutes) } : {}),
          ...(typeof args.name === 'string' && args.name.trim() ? { name: args.name.trim() } : {}),
          ...where,
        };
        const { wake } = await api.wakes<{ wake: WakeView }>('POST', '', workspaceId, body);
        return { text: `wake set: ${line(wake)}`, isError: false };
      }
      case 'list_wakes': {
        const { wakes } = await api.wakes<{ wakes: WakeView[] }>('GET', '', workspaceId);
        return { text: wakes.length ? wakes.map(line).join('\n') : 'no wakes waiting', isError: false };
      }
      case 'cancel_wake': {
        const id = typeof args.wake_id === 'string' ? args.wake_id.trim() : '';
        if (!id) return { text: 'cancel_wake needs a wake_id', isError: true };
        await api.wakes('DELETE', encodeURIComponent(id), workspaceId);
        return { text: `wake ${id} cancelled`, isError: false };
      }
      default:
        return { text: `unknown tool ${name}`, isError: true };
    }
  } catch (err) {
    if (err instanceof FlowApiError) return { text: err.status === 404 ? 'no such wake waiting (list_wakes gives the ids)' : err.message, isError: true };
    throw err;
  }
}
