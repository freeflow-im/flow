// The `flow` MCP stdio server (rich mode, operator ruling 6): messaging
// (send_message, react, upload_file, search_history), the key channel
// operations (list_channels, list_users, join_channel, leave_channel,
// create_channel, invite_to_channel, read_messages), and self-service profile
// bits (set_avatar) against /v1
// with the agent token, and the agent's calendar (list_my_events, get_event, respond_to_event, find_free_time,
// create_event; calendar-tools.ts), and its mailbox (list_mail, search_mail, read_mail, send_mail, move_mail, mark_mail;
// mail-tools.ts).
//
// Hand-rolled newline-delimited JSON-RPC (the MCP stdio transport) — a small
// fixed tool surface; no SDK dependency needed. Conversation context
// (channel/thread) arrives via env from the bridge's per-run --mcp-config.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import type { ArtifactDTO, WorkspaceMemberDTO } from '@flow/shared';
import { FlowApi, FlowApiError } from './api.js';
import { attachmentFilename, formatAttachments } from './attachments.js';
import { deliverArtifact, deliveryId, inlineArtifactFile } from './artifact-delivery.js';
import { CALENDAR_TOOLS, CALENDAR_TOOL_NAMES, calendarTool } from './calendar-tools.js';
import { MAIL_TOOLS, MAIL_TOOL_NAMES, mailTool } from './mail-tools.js';

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

/** How a channel is named in tool output — DMs have no name, only a kind. */
const channelLabel = (c: { name: string | null; kind: string }): string =>
  c.name ? `#${c.name}` : `(${c.kind})`;

/** One member as a `list_users` line. The email is member-visible data the
 * members API already returns to anyone in the workspace (#488) — carrying it
 * here is what lets an agent email a colleague without falling back to raw
 * HTTP. Agents' synthetic addresses print as-is.
 *
 * A member in privacy mode (#489) arrives with no address at all: the server
 * has already emptied the field, so the line simply omits that column rather
 * than printing a gap an agent might read as a name. Their id and name stay —
 * privacy mode hides an address, it does not hide a person. */
export const memberLine = (m: WorkspaceMemberDTO): string =>
  [
    m.userId,
    `${m.displayName}${m.isAgent ? ' 🤖' : ''}`,
    ...(m.email ? [m.email] : []),
    `[${m.role}]${m.statusText ? ` — ${m.statusText}` : ''}`,
  ].join('  ');

/** Lease for an indicator set by hand via set_channel_indicator (#137). Longer
 * than the per-turn one, because nothing refreshes this one — but still bounded,
 * so an agent that forgets to clear it doesn't leave a channel spinning. */
const MANUAL_INDICATOR_TTL_SECONDS = 300;
const processDeliveryScope = deliveryId('mcp-session', String(Date.now()), String(Math.random()));
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Where a messaging tool call lands (#320).
 *
 * The ambient conversation — the channel, plus the thread when the agent was
 * asked inside one — is inherited only by a call that names no channel of its
 * own. Naming `channelId` means "post there, top-level", even when it is the
 * very channel the ambient thread lives in: an agent conversing in a thread
 * has to be able to reach the channel itself (dispatching another agent, say),
 * and before this it could not. A thread is joined only by asking for it — a
 * non-empty `threadRootId`. The empty string is an explicit "top-level", never
 * a silent fall back to the ambient thread. */
export function resolveMessageTarget(
  args: { channelId?: unknown; threadRootId?: unknown },
  ambient: { channelId: string; threadRootId: string | undefined },
): { channelId: string; threadRootId: string | undefined } {
  const channelId = typeof args.channelId === 'string' ? args.channelId.trim() : '';
  const threadGiven = typeof args.threadRootId === 'string';
  const threadRootId = threadGiven ? (args.threadRootId as string).trim() : '';
  if (threadRootId) return { channelId: channelId || ambient.channelId, threadRootId };
  if (threadGiven || channelId) return { channelId: channelId || ambient.channelId, threadRootId: undefined };
  return { channelId: ambient.channelId, threadRootId: ambient.threadRootId };
}

const TOOLS = [
  {
    name: 'send_message',
    description:
      'Send a message to a Flow channel or thread immediately. With no channelId it replies in the current ' +
      'conversation — inside the current thread, when you were asked in one. Passing channelId posts TOP-LEVEL in ' +
      'that channel (this is how you reach a channel from inside a thread); add threadRootId to reply into a ' +
      'specific thread instead. Mention users as <@userId>.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message body (markdown).' },
        channelId: {
          type: 'string',
          description:
            'Target channel id. Omit for the current conversation; naming one posts top-level there unless ' +
            'threadRootId is also given.',
        },
        threadRootId: {
          type: 'string',
          description:
            'Reply into this thread. Omitting it inherits the current thread only when channelId is omitted too; ' +
            'pass an empty string to force top-level.',
        },
      },
      required: ['text'],
    },
  },
  {
    name: 'react',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object',
      properties: {
        messageId: { type: 'string', description: 'Message id to react to.' },
        emoji: { type: 'string', description: 'A single unicode emoji, e.g. 👍' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  {
    name: 'upload_file',
    description: 'Upload a local file attachment. For a report, comparison matrix, or other substantial deliverable, use create_artifact instead: it creates the report and posts an Open report card.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path to the file on disk.' },
        channelId: {
          type: 'string',
          description:
            'Target channel id. Omit for the current conversation; naming one posts top-level there unless ' +
            'threadRootId is also given.',
        },
        threadRootId: {
          type: 'string',
          description:
            'Reply into this thread. Omitting it inherits the current thread only when channelId is omitted too; ' +
            'pass an empty string to force top-level.',
        },
        comment: { type: 'string', description: 'Optional message text to accompany the file.' },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_history',
    description: 'Search recent messages in a Flow channel for a substring (case-insensitive).',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Text to search for.' },
        channelId: { type: 'string', description: 'Channel to search (default: current conversation).' },
        limit: { type: 'number', description: 'Max matches to return (default 10).' },
      },
      required: ['query'],
    },
  },
  {
    name: 'list_channels',
    description: 'List channels in the workspace (id, name, kind, private/member flags, topic).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'list_users',
    description:
      'List workspace members (id, display name, email, role; 🤖 marks agents). Use the ids in <@userId> mentions, and the emails to reach people outside Flow. Some members keep their address private — their line simply has no email, and there is no other way to get it.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'join_channel',
    description: 'Join a public channel by id (required before reading or posting in channels you are not a member of).',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string', description: 'Channel id to join.' } },
      required: ['channelId'],
    },
  },
  {
    name: 'set_channel_indicator',
    description:
      "Show or hide the small spinner on a channel's sidebar row, marking it as one you are actively working in. " +
      'The bridge already does this for the channel you were asked in, for as long as the turn runs — use this only ' +
      'to mark a *different* channel busy (e.g. one you handed work off to). It lapses on its own after five minutes ' +
      'unless you set it again, so clear it when the work is done rather than relying on that.',
    inputSchema: {
      type: 'object',
      properties: {
        state: { type: 'string', enum: ['busy', 'none'], description: "'busy' spins the row, 'none' stops it." },
        channelId: { type: 'string', description: 'Channel id (default: current conversation).' },
      },
      required: ['state'],
    },
  },
  {
    name: 'set_channel_emoji',
    description:
      "Set the small emoji shown after a channel's name in the sidebar — a persistent status glyph (🚧 building, " +
      '✅ done, 🔥 incident) that stays until someone changes or clears it. This is decoration, not activity: ' +
      'it is NOT the temporary spinner set_channel_indicator shows while you work, and it does not lapse on its own. ' +
      'Pass an empty emoji (or omit it) to clear. You must be a member of the channel.',
    inputSchema: {
      type: 'object',
      properties: {
        emoji: {
          type: 'string',
          description: 'One emoji, e.g. "🔥". Empty string clears it. Anything but a single emoji is rejected.',
        },
        channelId: { type: 'string', description: 'Channel id (default: current conversation).' },
      },
      required: [],
    },
  },
  {
    name: 'leave_channel',
    description: 'Leave a channel by id.',
    inputSchema: {
      type: 'object',
      properties: { channelId: { type: 'string', description: 'Channel id to leave.' } },
      required: ['channelId'],
    },
  },
  {
    name: 'create_channel',
    description:
      'Create a new channel in the workspace and join it. Names are lowercase letters, digits, - and _ (max 80 chars). Returns the new channel id — use it with invite_to_channel and send_message.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Channel name without the #, e.g. incident-2026-07-25.' },
        topic: { type: 'string', description: 'Optional channel topic (max 250 chars).' },
        isPrivate: {
          type: 'boolean',
          description: 'Private channel — visible only to its members (default false).',
        },
        parentId: {
          type: 'string',
          description:
            'Nest the new channel under this existing channel or DM — it shows indented beneath it in the sidebar. You must be a member of the parent, it must not be archived, and it must not already be a sub-channel (one level only). Nesting under a DM makes the new channel private and adds everyone in that DM, so it is the place to put a long build log or working notes without filling the conversation. Get ids from list_channels.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'start_task',
    description:
      'Hand off long-running work (a ticket, a build, a multi-step job) to a separate run of yourself homed in another channel, and return immediately — use it when a requester should not have to wait in this conversation. The new run starts fresh with your prompt as its ONLY instructions: it inherits nothing from here, so make the prompt self-contained (the goal, ids, who asked and their <@userId>, where to report back). The target channel becomes the run’s conversation — its progress indicator, messages and final reply post there top-level, and anyone who talks in that channel is talking to the run with its full context. Typical shape: create_channel + invite_to_channel first, then start_task, then reply here with a one-line pointer to the channel. Do NOT do the work yourself after a successful handoff.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: {
          type: 'string',
          description: 'Channel to home the run in — you must be a member (typically one you just created).',
        },
        prompt: {
          type: 'string',
          description: 'Complete, self-contained instructions for the run. It does not see this conversation.',
        },
      },
      required: ['channelId', 'prompt'],
    },
  },
  {
    name: 'invite_to_channel',
    description:
      'Add workspace members to a channel. Pass several userIds to invite a group in one call — each is added independently and the result reports any that failed. Get ids from list_users.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel to add people to (default: current conversation).' },
        userIds: { type: 'array', items: { type: 'string' }, description: 'User ids to add.' },
      },
      required: ['userIds'],
    },
  },
  {
    name: 'set_avatar',
    description:
      'Set your own avatar from a local image file (png/jpeg/gif/webp — the server square-crops it to 512px).',
    inputSchema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path to the image file on disk.' } },
      required: ['path'],
    },
  },
  {
    name: 'create_artifact',
    description:
      'Create a persistent report/artifact shared with the channel and deliver an Open report card in this conversation. Use this for reports and comparison matrices; uploading a file alone is not report delivery. Markdown is rendered as a document. Returns saved artifact and delivery status. Use update_artifact for revisions and deliver_artifact to retry a failed card delivery.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name for the artifact (defaults to the file name, or to a name derived from the url).' },
        content: { type: 'string', description: 'Inline file content to upload (use with name; mimeType recommended).' },
        mimeType: { type: 'string', description: 'Inline format (default text/markdown; use text/html for HTML artifacts).' },
        filename: { type: 'string', description: 'Backing filename, separate from the display name; extension is added when omitted.' },
        operationId: { type: 'string', description: 'Optional UUID identifying this creation; reuse on retry. Otherwise derived from the source message and input.' },
        threadRootId: { type: 'string', description: 'Delivery thread (default: current thread).' },
        path: { type: 'string', description: 'Path to a local file to upload instead of inline content.' },
        fileId: { type: 'string', description: 'Id of a file already uploaded/shared in Flow to pin as-is.' },
        url: { type: 'string', description: 'http(s) URL to pin as a link artifact instead of a file. Mutually exclusive with content/path/fileId.' },
        channelId: { type: 'string', description: 'Channel to pin the artifact in (default: the current conversation).' },
        app: {
          type: 'boolean',
          description:
            'Register this url as an app (url only): only members of the channel can reach it. The response carries a secret, returned ONCE — run `FLOW_APP_SECRET=<secret> npx flow-agent-bridge app-guard --upstream <your local app> --port 8788` and tunnel 8788 instead of the app. The guard authenticates viewers offline and passes their identity to your app in X-Flow-User-Id / X-Flow-User-Name headers.',
        },
      },
    },
  },
  {
    name: 'deliver_artifact',
    description: 'Post or retry the Open report card for a saved artifact without creating a duplicate. Uses the saved original channel and thread.',
    inputSchema: { type: 'object', properties: { artifactId: { type: 'string' } }, required: ['artifactId'] },
  },
  {
    name: 'update_artifact',
    description:
      'Update an existing artifact in place — rename it and/or replace its content. Everyone viewing it sees the new version. For a file artifact provide new content inline, a local file path, or the id of an already-uploaded file; for a link artifact provide a new url; and/or a new name for either kind.',
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'Id of the artifact to update (from create_artifact).' },
        name: { type: 'string', description: 'New display name (optional).' },
        content: { type: 'string', description: 'New inline content to replace the file with (mimeType recommended).' },
        mimeType: { type: 'string', description: 'Mime type for inline content (default text/plain; use text/html for HTML).' },
        path: { type: 'string', description: 'Path to a local file whose contents replace the artifact.' },
        fileId: { type: 'string', description: 'Id of an already-uploaded file to point the artifact at.' },
        url: { type: 'string', description: 'New http(s) URL for a link artifact. Mutually exclusive with content/path/fileId; rejected on file artifacts.' },
      },
      required: ['artifactId'],
    },
  },
  {
    name: 'delete_artifact',
    description:
      'Delete an artifact: it is unpinned from its channel for everyone and is gone for good — there is no undo, so prefer update_artifact when you only want to replace the content. Works for file, link and app artifacts. Find ids with list_artifacts (or keep the one create_artifact returned).',
    inputSchema: {
      type: 'object',
      properties: {
        artifactId: { type: 'string', description: 'Id of the artifact to delete (from create_artifact or list_artifacts).' },
      },
      required: ['artifactId'],
    },
  },
  {
    name: 'list_artifacts',
    description:
      'List the artifacts pinned in a channel (default: the current conversation) — id, kind (file or link), name, url or file info, and when each was last updated. Use the ids with update_artifact, or download_file with a file artifact’s fileId.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel whose artifacts to list (default: current conversation).' },
      },
    },
  },
  {
    name: 'read_messages',
    description:
      'Read messages from a channel, newest first. Page backwards by passing `before` = the oldest message id from the previous page. Messages with attachments list them as `[attachments: <fileId> "name" (type, size)]` — pass a file id to download_file to fetch the bytes.',
    inputSchema: {
      type: 'object',
      properties: {
        channelId: { type: 'string', description: 'Channel to read (default: current conversation).' },
        limit: { type: 'number', description: 'Messages per page (default 25, max 200).' },
        before: { type: 'string', description: 'Only messages older than this message id (paging cursor).' },
      },
    },
  },
  {
    name: 'download_file',
    description:
      'Download a file attached to a Flow message to a local path, and return that path (Read it to view the contents; images render). Take the file id from the [attachments: …] note on a read_messages or search_history line.',
    inputSchema: {
      type: 'object',
      properties: {
        fileId: { type: 'string', description: 'Id of the file to download.' },
        path: {
          type: 'string',
          description: 'Where to write it (default: a temp file named after the attachment).',
        },
      },
      required: ['fileId'],
    },
  },
  ...CALENDAR_TOOLS,
  ...MAIL_TOOLS,
];

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.csv': 'text/csv',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
};

/** Per-user failure text for invite_to_channel. The server's own messages are
 * already agent-readable (`dm_channel`, `channel_archived`, `bad_user`), so
 * they pass through — except 404, which a private channel the agent isn't in
 * also returns (membership privacy), making "channel not found" misleading. */
function inviteErrorText(err: unknown): string {
  if (!(err instanceof FlowApiError)) return (err as Error).message;
  if (err.status === 404) {
    return 'channel not found, or it is private and you are not a member (only members can invite to a private channel)';
  }
  return err.message;
}

/** The slice of FlowApi that `deleteArtifactTool` uses — narrow so a test can
 * stand in for it without a server. */
interface ArtifactDeleteApi {
  listArtifacts(workspaceId: string): Promise<ArtifactDTO[]>;
  deleteArtifact(artifactId: string): Promise<void>;
}

/** How an artifact is described back to the agent — the same three words
 * list_artifacts tags its rows with. */
const artifactKindLabel = (a: ArtifactDTO): string => (a.kind === 'link' ? (a.isApp ? 'app' : 'link') : 'file');

/**
 * delete_artifact (#393). The id is resolved against the caller's visible
 * artifacts *before* the DELETE, for two reasons: the confirmation can then
 * name what it removed, and an unknown id becomes a clear error instead of a
 * false success — the server's delete is deliberately idempotent, so it answers
 * `ok` for an artifact that never existed. The lookup is membership-scoped, so
 * an artifact in a channel this agent is not in reads as not-found here, which
 * is the same gate the DELETE would have applied a moment later.
 */
export async function deleteArtifactTool(
  api: ArtifactDeleteApi,
  workspaceId: string,
  artifactId: string,
): Promise<{ text: string; isError: boolean }> {
  if (!artifactId) {
    return { text: 'delete_artifact needs an artifactId (get one from list_artifacts)', isError: true };
  }
  if (!workspaceId) {
    return { text: 'delete_artifact needs a workspace (FLOW_WORKSPACE_ID is not set)', isError: true };
  }
  let visible: ArtifactDTO[];
  try {
    visible = await api.listArtifacts(workspaceId);
  } catch (err) {
    return { text: `delete_artifact could not reach the Flow server: ${(err as Error).message}`, isError: true };
  }
  const target = visible.find((a) => a.id === artifactId);
  if (!target) {
    return {
      text:
        `no artifact ${artifactId} — it may already be deleted, or it may live in a channel you are not a member of. ` +
        'Run list_artifacts to see the ids you can delete.',
      isError: true,
    };
  }
  try {
    await api.deleteArtifact(artifactId);
  } catch (err) {
    const detail =
      err instanceof FlowApiError && err.status === 403
        ? 'you are not a member of its channel'
        : (err as Error).message;
    return { text: `could not delete "${target.name}" (id ${artifactId}): ${detail}`, isError: true };
  }
  return {
    text: `${artifactKindLabel(target)} artifact "${target.name}" (id ${artifactId}) deleted — unpinned from its channel for everyone.`,
    isError: false,
  };
}

/** POST JSON to the bridge daemon over its local task socket (FLOW_BRIDGE_SOCK): `/task` for start_task, `/job` for
 * the wake job whose turn is running in this conversation. */
function bridgeIpcPost<T = { ok: true; note: string } | { error: string }>(
  socketPath: string,
  payload: unknown,
  route: '/task' | '/job' = '/task',
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      { socketPath, path: route, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => (data += chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(data) as T);
          } catch {
            reject(new Error(`bad bridge response (status ${res.statusCode})`));
          }
        });
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`bridge did not answer within ${timeoutMs / 1000}s`)));
    req.on('error', reject);
    req.end(body);
  });
}

export async function runMcpServer(): Promise<void> {
  const serverUrl = process.env.FLOW_SERVER_URL ?? '';
  const token = process.env.FLOW_AGENT_TOKEN ?? '';
  const workspaceId = process.env.FLOW_WORKSPACE_ID ?? '';
  const defaultChannelId = process.env.FLOW_CHANNEL_ID ?? '';
  const defaultThreadRootId = process.env.FLOW_THREAD_ROOT_ID || undefined;
  if (!serverUrl || !token) {
    process.stderr.write('flow mcp: FLOW_SERVER_URL and FLOW_AGENT_TOKEN are required\n');
    process.exit(1);
  }
  // During a wake job's turn every request carries the job (x-flow-job), so the events it causes say so (platform.md
  // §5.2, loop safety). The bridge knows which conversation's turn is a job's; this process asks it before each request.
  const sock = process.env.FLOW_BRIDGE_SOCK || '';
  const jobHeader = async (): Promise<Record<string, string>> => {
    if (!sock) return {};
    try {
      const { jobId } = await bridgeIpcPost<{ jobId: string | null }>(sock, { channelId: defaultChannelId, threadRootId: defaultThreadRootId ?? '' }, '/job', 2_000);
      return jobId ? { 'x-flow-job': jobId } : {};
    } catch {
      return {};
    }
  };
  const api = new FlowApi(serverUrl, token, jobHeader);

  const write = (msg: unknown): void => {
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const reply = (id: number | string | null, result: unknown): void => {
    write({ jsonrpc: '2.0', id, result });
  };
  const replyError = (id: number | string | null, code: number, message: string): void => {
    write({ jsonrpc: '2.0', id, error: { code, message } });
  };
  const toolText = (text: string, isError = false) => ({ content: [{ type: 'text', text }], isError });

  /** Resolve artifact args to a file id: an existing `fileId` (pinned as-is,
   * ownsFile=false), or a `path`/`content` upload (owned by the artifact,
   * ownsFile=true). Returns `{ error: true }` when no source was given. */
  async function resolveArtifactFile(
    args: Record<string, unknown>,
    label: string | undefined,
  ): Promise<{ fileId: string; label: string | undefined; ownsFile: boolean; fingerprint: string } | { error: true }> {
    const existing = (args.fileId as string | undefined) || '';
    if (existing) return { fileId: existing, label, ownsFile: false, fingerprint: existing };
    let filename: string;
    let mime: string;
    let data: Buffer;
    if (args.path) {
      const p = path.resolve(String(args.path));
      data = fs.readFileSync(p);
      filename = path.basename(p);
      mime = String(args.mimeType ?? '') || MIME_BY_EXT[path.extname(p).toLowerCase()] || 'application/octet-stream';
    } else if (typeof args.content === 'string') {
      const inline = inlineArtifactFile(label, String(args.mimeType ?? ''), String(args.filename ?? ''));
      filename = inline.filename;
      mime = inline.mime;
      data = Buffer.from(args.content, 'utf8');
    } else {
      return { error: true };
    }
    const file = await api.uploadFile(workspaceId, filename, mime, data);
    return { fileId: file.id, label: label ?? filename, ownsFile: true, fingerprint: deliveryId(filename, mime, data.toString('base64')) };
  }

  async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    if (CALENDAR_TOOL_NAMES.has(name)) {
      const out = await calendarTool(api, workspaceId, name, args);
      return toolText(out.text, out.isError);
    }
    if (MAIL_TOOL_NAMES.has(name)) {
      const out = await mailTool(api, workspaceId, name, args);
      return toolText(out.text, out.isError);
    }
    const { channelId, threadRootId } = resolveMessageTarget(args, {
      channelId: defaultChannelId,
      threadRootId: defaultThreadRootId,
    });
    switch (name) {
      case 'send_message': {
        const msg = await api.sendMessage(channelId, String(args.text ?? ''), threadRootId);
        return toolText(`sent (message id ${msg.id})`);
      }
      case 'react': {
        await api.addReaction(String(args.messageId ?? ''), String(args.emoji ?? ''));
        return toolText('reaction added');
      }
      case 'upload_file': {
        const p = path.resolve(String(args.path ?? ''));
        const data = fs.readFileSync(p);
        const filename = path.basename(p);
        const mime = MIME_BY_EXT[path.extname(p).toLowerCase()] ?? 'application/octet-stream';
        const file = await api.uploadFile(workspaceId, filename, mime, data);
        const msg = await api.sendMessage(channelId, String(args.comment ?? filename), threadRootId, [file.id]);
        return toolText(`uploaded ${filename} (message id ${msg.id})`);
      }
      case 'search_history': {
        const q = String(args.query ?? '').toLowerCase();
        const limit = Math.min(Number(args.limit ?? 10), 50);
        const page = await api.listMessages(channelId, 200);
        const hits = page.messages
          .filter((m) => !m.deletedAt && m.body.toLowerCase().includes(q))
          .slice(-limit)
          .map((m) => `[${m.createdAt} <@${m.userId}> msg ${m.id}] ${m.body.slice(0, 300)}${formatAttachments(m.files)}`);
        return toolText(hits.length ? hits.join('\n') : 'no matches');
      }
      case 'list_channels': {
        const channels = await api.listChannels(workspaceId);
        const labelById = new Map(channels.map((c) => [c.id, channelLabel(c)]));
        const lines = channels
          .filter((c) => !c.archivedAt)
          .map((c) => {
            const flags = [c.isPrivate ? 'private' : 'public', c.isMember ? 'member' : 'not-member'].join(', ');
            const label = channelLabel(c);
            // Show the parent by name so an agent can see the nesting without
            // cross-referencing ids itself.
            const under = c.parentId ? `  under ${labelById.get(c.parentId) ?? c.parentId}` : '';
            return `${c.id}  ${label}  [${flags}]${under}${c.topic ? ` — ${c.topic}` : ''}`;
          });
        return toolText(lines.length ? lines.join('\n') : 'no channels');
      }
      case 'list_users': {
        const members = await api.listMembers(workspaceId);
        return toolText(members.map(memberLine).join('\n'));
      }
      case 'join_channel': {
        await api.joinChannel(String(args.channelId ?? ''));
        return toolText('joined');
      }
      case 'leave_channel': {
        await api.leaveChannel(String(args.channelId ?? ''));
        return toolText('left');
      }
      case 'set_channel_indicator': {
        const state = String(args.state ?? '');
        if (state !== 'busy' && state !== 'none') {
          return toolText("set_channel_indicator needs state 'busy' or 'none'", true);
        }
        const target = args.channelId ? String(args.channelId) : channelId;
        // Nothing refreshes a hand-set indicator, so it gets a longer lease
        // than the per-turn one the reporter keeps alive.
        await api.setChannelIndicator(target, state, MANUAL_INDICATOR_TTL_SECONDS);
        return toolText(state === 'busy' ? 'channel marked busy' : 'channel indicator cleared');
      }
      case 'set_channel_emoji': {
        const target = args.channelId ? String(args.channelId) : channelId;
        const emoji = typeof args.emoji === 'string' ? args.emoji.trim() : '';
        // Empty means clear, so it goes over the wire as null rather than ''.
        const res = await api.setChannelEmoji(target, emoji || null);
        return toolText(res.emoji ? `channel emoji set to ${res.emoji}` : 'channel emoji cleared');
      }
      case 'create_channel': {
        const name = String(args.name ?? '').trim();
        if (!name) return toolText('create_channel needs a name', true);
        try {
          const created = await api.createChannel(workspaceId, {
            name,
            ...(args.topic ? { topic: String(args.topic) } : {}),
            ...(args.isPrivate === true ? { isPrivate: true } : {}),
            ...(args.parentId ? { parentId: String(args.parentId) } : {}),
          });
          // Name the parent rather than echo its id back — the agent passed the
          // id in, so repeating it says nothing about whether nesting worked.
          const parentLabel = created.parentId
            ? await api
                .listChannels(workspaceId)
                .then((cs) => {
                  const p = cs.find((c) => c.id === created.parentId);
                  return p ? channelLabel(p) : undefined;
                })
                .catch(() => undefined)
            : undefined;
          const nested = created.parentId ? ` — under ${parentLabel ?? created.parentId}` : '';
          return toolText(
            `created #${created.name} (id ${created.id})${created.isPrivate ? ' — private' : ''}${nested}; you are a member`,
          );
        } catch (err) {
          if (err instanceof FlowApiError && err.code === 'channel_exists') {
            // hand back the existing id when we can see it, so the agent can just use it
            const existing = await api
              .listChannels(workspaceId)
              .then((cs) => cs.find((c) => c.name === name))
              .catch(() => undefined);
            return toolText(
              existing
                ? `a channel named #${name} already exists (id ${existing.id}) — use it instead of creating one`
                : `a channel named #${name} already exists`,
              true,
            );
          }
          throw err;
        }
      }
      case 'start_task': {
        const sock = process.env.FLOW_BRIDGE_SOCK || '';
        if (!sock) {
          return toolText(
            'start_task is unavailable (no bridge daemon behind this run) — do the work in this conversation instead',
            true,
          );
        }
        const target = String(args.channelId ?? '').trim();
        const prompt = String(args.prompt ?? '').trim();
        if (!target || !prompt) return toolText('start_task needs channelId and prompt', true);
        try {
          const out = await bridgeIpcPost(sock, {
            channelId: target,
            prompt,
            userId: process.env.FLOW_USER_ID || '',
            sourceChannelId: defaultChannelId,
          });
          if ('error' in out) return toolText(`start_task failed: ${out.error}`, true);
          return toolText(
            `${out.note}. The run works there on its own — post a one-line pointer for the requester here and end this turn; don't do the task yourself.`,
          );
        } catch (err) {
          return toolText(
            `start_task failed: ${(err as Error).message} — do the work in this conversation instead`,
            true,
          );
        }
      }
      case 'invite_to_channel': {
        if (!channelId) return toolText('invite_to_channel needs a channelId', true);
        const raw = Array.isArray(args.userIds)
          ? args.userIds
          : [args.userIds ?? args.userId].filter((v) => v !== undefined && v !== null);
        const userIds = [...new Set(raw.map((u) => String(u).trim()).filter(Boolean))].slice(0, 50);
        if (userIds.length === 0) return toolText('invite_to_channel needs one or more userIds', true);
        // one call per user (the server adds one at a time); report each outcome
        const added: string[] = [];
        const failed: string[] = [];
        for (const userId of userIds) {
          try {
            await api.addChannelMember(channelId, userId);
            added.push(userId);
          } catch (err) {
            failed.push(`<@${userId}>: ${inviteErrorText(err)}`);
          }
        }
        const summary = added.length ? `invited ${added.map((u) => `<@${u}>`).join(', ')}` : 'invited nobody';
        const detail = failed.length ? `\nfailed:\n${failed.join('\n')}` : '';
        return toolText(summary + detail, added.length === 0);
      }
      case 'set_avatar': {
        const p = path.resolve(String(args.path ?? ''));
        const mime = MIME_BY_EXT[path.extname(p).toLowerCase()] ?? '';
        if (!mime.startsWith('image/')) return toolText('set_avatar needs a png/jpeg/gif/webp image', true);
        await api.setAvatar(path.basename(p), mime, fs.readFileSync(p));
        return toolText('avatar updated');
      }
      case 'create_artifact': {
        if (!channelId) {
          return toolText('create_artifact needs a channelId (no conversation context to infer the channel)', true);
        }
        if (args.operationId !== undefined && (typeof args.operationId !== 'string' || !UUID_RE.test(args.operationId))) {
          return toolText('operationId must be a UUID', true);
        }
        const artifactName = (args.name as string | undefined) || undefined;
        const url = (args.url as string | undefined) || undefined;
        const hasFileSource = Boolean(args.fileId || args.path || typeof args.content === 'string');
        if (url && hasFileSource) {
          return toolText('create_artifact takes either url (link artifact) or one file source (content/path/fileId), not both', true);
        }
        const asApp = args.app === true;
        if (asApp && !url) return toolText('create_artifact: app is only valid with url', true);
        if (url) {
          if (!/^https?:\/\//i.test(url)) return toolText('url must be http(s)', true);
          const created = await api.createArtifact(channelId, { url, name: artifactName, app: asApp });
          if (!asApp) return toolText(`link artifact "${created.name}" created (id ${created.id})`);
          // The secret exists in this one response and nowhere else — Flow
          // cannot show it again (docs/design/MINI_APPS.md), so hand it to the
          // agent with the exact command it is for.
          if (!created.appSecret) {
            return toolText(
              `app artifact "${created.name}" created (id ${created.id}) but the server returned no secret — this Flow server may predate mini apps`,
              true,
            );
          }
          return toolText(
            `app artifact "${created.name}" created (id ${created.id}).\n` +
              'Only members of this channel can reach it. Put the guard in front of your local app and tunnel the GUARD\'s port:\n' +
              `  FLOW_APP_SECRET=${created.appSecret} npx flow-agent-bridge app-guard --upstream http://localhost:3000 --port 8788\n` +
              'This secret is shown once and is not stored in Flow — keep it if you need to restart the guard. ' +
              'Your app receives each viewer as X-Flow-User-Id / X-Flow-User-Name / X-Flow-Is-Agent headers.',
          );
        }
        // resolve a file id: pin an existing file, or upload path/content (owned)
        const resolved = await resolveArtifactFile(args, artifactName);
        if ('error' in resolved) return toolText(`create_artifact needs one of: content, path, fileId, or url`, true);
        const created = await api.createArtifact(channelId, {
          fileId: resolved.fileId,
          name: resolved.label,
          ownsFile: resolved.ownsFile,
          operationId: String(args.operationId || deliveryId('create-artifact', process.env.FLOW_SOURCE_MESSAGE_ID || processDeliveryScope, channelId, threadRootId ?? '', resolved.label ?? '', resolved.fingerprint)),
          ...(process.env.FLOW_USER_ID && channelId === defaultChannelId ? { requesterUserId: process.env.FLOW_USER_ID } : {}),
          ...(threadRootId ? { sourceThreadRootId: threadRootId } : {}),
        });
        return deliverArtifact(api, created, threadRootId);
      }
      case 'deliver_artifact': {
        const saved = await api.getArtifact(String(args.artifactId ?? ''));
        return deliverArtifact(api, saved, saved.sourceThreadRootId ?? undefined);
      }
      case 'update_artifact': {
        const artifactId = (args.artifactId as string | undefined) || '';
        if (!artifactId) return toolText('update_artifact needs an artifactId', true);
        const name = (args.name as string | undefined) || undefined;
        const url = (args.url as string | undefined) || undefined;
        const hasNewContent = args.fileId || args.path || typeof args.content === 'string';
        if (url && hasNewContent) {
          return toolText('update_artifact takes either url (link artifact) or new file content, not both', true);
        }
        if (url && !/^https?:\/\//i.test(url)) return toolText('url must be http(s)', true);
        if (!name && !hasNewContent && !url) {
          return toolText('update_artifact needs a name, a url (link artifacts), and/or new content (content, path, or fileId)', true);
        }
        const patch: { name?: string; fileId?: string; ownsFile?: boolean; url?: string } = {};
        if (name) patch.name = name;
        if (url) patch.url = url;
        if (hasNewContent) {
          const resolved = await resolveArtifactFile(args, name);
          if ('error' in resolved) return toolText('update_artifact could not read the new content', true);
          patch.fileId = resolved.fileId;
          patch.ownsFile = resolved.ownsFile;
        }
        const updated = await api.updateArtifact(artifactId, patch);
        return toolText(`artifact "${updated.name}" updated`);
      }
      case 'delete_artifact': {
        const result = await deleteArtifactTool(api, workspaceId, (args.artifactId as string | undefined) || '');
        return toolText(result.text, result.isError);
      }
      case 'list_artifacts': {
        if (!channelId) {
          return toolText('list_artifacts needs a channelId (no conversation context to infer the channel)', true);
        }
        const all = await api.listArtifacts(workspaceId);
        const rows = all.filter((a) => a.channelId === channelId);
        if (rows.length === 0) return toolText('no artifacts in this channel');
        const lines = rows.map((a) =>
          a.kind === 'link'
            ? `[${a.isApp ? 'app' : 'link'}] "${a.name}" (id ${a.id}) → ${a.url} — updated ${a.updatedAt}`
            : `[file] "${a.name}" (id ${a.id}) — fileId ${a.fileId}${a.file ? `, ${a.file.mimeType}, ${a.file.sizeBytes} bytes` : ''} — updated ${a.updatedAt}`,
        );
        return toolText(lines.join('\n'));
      }
      case 'read_messages': {
        const limit = Math.min(Math.max(Number(args.limit ?? 25), 1), 200);
        const before = (args.before as string | undefined) || undefined;
        const page = await api.listMessages(channelId, limit, before);
        // newest first, regardless of server response order (uuidv7 ids sort by time)
        const msgs = [...page.messages].sort((a, b) => (a.id < b.id ? 1 : -1));
        if (msgs.length === 0) return toolText('no messages');
        const oldest = msgs[msgs.length - 1]!;
        const lines = msgs.map(
          (m) =>
            `[${m.createdAt} <@${m.userId}> msg ${m.id}]${m.threadRootId ? ` (in thread ${m.threadRootId})` : ''} ${m.deletedAt ? '(deleted)' : m.body.slice(0, 500) + formatAttachments(m.files)}`,
        );
        const footer = page.hasMore ? `\n(more — pass before=${oldest.id} for the next page)` : '';
        return toolText(lines.join('\n') + footer);
      }
      case 'download_file': {
        const fileId = String(args.fileId ?? '');
        if (!fileId) return toolText('download_file needs a fileId (from an [attachments: …] note)', true);
        const file = await api.downloadFileWithMeta(fileId);
        const dest = args.path
          ? path.resolve(String(args.path))
          : path.join(os.tmpdir(), 'flow-attachments', attachmentFilename(fileId, file.filename));
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, file.data, { mode: 0o600 });
        return toolText(`${dest} (${file.mimeType ?? 'unknown type'}, ${file.data.length} bytes)`);
      }
      default:
        return toolText(`unknown tool: ${name}`, true);
    }
  }

  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    void (async () => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let req: JsonRpcRequest;
      try {
        req = JSON.parse(trimmed) as JsonRpcRequest;
      } catch {
        return; // not for us
      }
      const id = req.id ?? null;
      try {
        switch (req.method) {
          case 'initialize':
            return reply(id, {
              protocolVersion: (req.params?.protocolVersion as string) ?? '2025-06-18',
              capabilities: { tools: {} },
              serverInfo: { name: 'flow', version: '0.1.0' },
            });
          case 'notifications/initialized':
          case 'notifications/cancelled':
            return; // notifications get no response
          case 'ping':
            return reply(id, {});
          case 'tools/list':
            return reply(id, { tools: TOOLS });
          case 'tools/call': {
            const name = String(req.params?.name ?? '');
            const args = (req.params?.arguments ?? {}) as Record<string, unknown>;
            try {
              return reply(id, await callTool(name, args));
            } catch (err) {
              return reply(id, toolText(`error: ${(err as Error).message}`, true));
            }
          }
          default:
            if (id !== null) replyError(id, -32601, `method not found: ${req.method}`);
            return;
        }
      } catch (err) {
        if (id !== null) replyError(id, -32603, (err as Error).message);
      }
    })();
  });
  // stay alive until stdin closes
  await new Promise<void>((resolve) => rl.on('close', resolve));
}
