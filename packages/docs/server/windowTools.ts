// The desktop app's windows as the place an agent's edit tools run (LiveEditor, plugin/server/files.ts). An
// MCP tool on a file open in a window is sent to that window (GET /api/local/tool-calls, server-sent events),
// which runs it on its open editor as the built-in assistant's tools run (client/src/agent/AgentProvider.tsx:
// undoable, destructive changes asked about) and posts the result back (POST /api/local/tool-calls/:id).
import { randomUUID } from 'node:crypto';
import { ToolError, type FileKind, type LiveEditor, type LiveResult } from '../plugin/server/files.ts';
import type { WindowToolCall } from '../shared/agent/protocol.ts';

export type { WindowToolCall };

/** What a window posts back: the tool's result, or `unavailable` when it does not have the file open after all. */
export type WindowToolAnswer = LiveResult | { unavailable: true };

/** Calls closer together than this are one run of the agent's, undone as one step. */
const GROUP_GAP_MS = 60_000;
/** How long a call may wait for its window, a question about a destructive change included. */
const CALL_TIMEOUT_MS = 10 * 60_000;

interface Pending {
  windowId: string;
  resolve(answer: WindowToolAnswer): void;
  reject(e: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

export class WindowTools implements LiveEditor {
  /** The connected windows, by the id each one made for itself. */
  private readonly windows = new Map<string, (call: WindowToolCall) => void>();
  /** The window that last said it shows each file: of several, the one brought forward last. */
  private readonly shownIn = new Map<string, string>();
  private readonly pending = new Map<string, Pending>();
  private group = { id: '', at: 0 };
  /** The undo group of the assistant panel's turn in progress (pinGroup), which all its calls share. */
  private pinned: string | null = null;
  /** The window that last said what it shows: the one brought forward last. */
  private front: string | null = null;

  /**
   * While a turn of the user's own agent runs in the assistant panel, every call it makes is one undo step,
   * however far apart; null goes back to grouping calls by how close together they are.
   */
  pinGroup(id: string | null): void {
    this.pinned = id;
  }

  /** A window connected; `send` delivers calls to it. Returns what to call when it disconnects. */
  connect(windowId: string, send: (call: WindowToolCall) => void): () => void {
    this.windows.set(windowId, send);
    return () => {
      if (this.windows.get(windowId) !== send) return;
      this.windows.delete(windowId);
      for (const [fileId, w] of this.shownIn) if (w === windowId) this.shownIn.delete(fileId);
      for (const [id, p] of this.pending) {
        if (p.windowId !== windowId) continue;
        this.settle(id)?.reject(new ToolError('The app’s window closed before the change was made. Check the file and try again.'));
      }
    };
  }

  /** A window reported the file it shows (null for none); it is the one in front. */
  showing(windowId: string, fileId: string | null): void {
    for (const [f, w] of this.shownIn) if (w === windowId) this.shownIn.delete(f);
    if (fileId) this.shownIn.set(fileId, windowId);
    this.front = windowId;
  }

  /** Run a tool on a stored file in the window in front (any, when none has said), whatever page it shows. */
  async runInFront(fileId: string, name: string, input: Record<string, unknown>): Promise<LiveResult | null> {
    const windowId = this.front && this.windows.has(this.front) ? this.front : this.windows.keys().next().value;
    return windowId ? this.call(windowId, { kind: 'file', fileId, name, input }) : null;
  }

  async run(file: { kind: FileKind; id: string }, name: string, input: Record<string, unknown>): Promise<LiveResult | null> {
    const windowId = this.shownIn.get(file.id);
    if (!windowId || !this.windows.has(windowId)) return null;
    return this.call(windowId, { kind: file.kind, fileId: file.id, name, input });
  }

  private async call(windowId: string, c: Omit<WindowToolCall, 'id' | 'group'>): Promise<LiveResult | null> {
    const send = this.windows.get(windowId)!;
    const now = Date.now();
    if (now - this.group.at > GROUP_GAP_MS) this.group.id = `mcp-${now}`;
    this.group.at = now;
    const group = this.pinned ?? this.group.id;
    const id = randomUUID();
    const answer = await new Promise<WindowToolAnswer>((resolve, reject) => {
      const timer = setTimeout(() => this.settle(id)?.reject(new ToolError('The app did not answer in time. Check the file and try again.')), CALL_TIMEOUT_MS);
      this.pending.set(id, { windowId, resolve, reject, timer });
      send({ ...c, id, group });
    });
    return 'unavailable' in answer ? null : answer;
  }

  /** A window's answer to a call; false when there is no such call (answered already, or timed out). */
  answer(id: string, answer: WindowToolAnswer): boolean {
    const p = this.settle(id);
    p?.resolve(answer);
    return !!p;
  }

  private settle(id: string): Pending | null {
    const p = this.pending.get(id);
    if (!p) return null;
    this.pending.delete(id);
    clearTimeout(p.timer);
    return p;
  }
}
