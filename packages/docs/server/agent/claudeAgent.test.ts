import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentTurnRequest } from '../../shared/agent/protocol.ts';
import { openDb } from '../db.ts';
import type { SheetStore } from '../sheets.ts';
import { AgentService } from './agent.ts';
import { APP_SERVER, ClaudeAgentDriver, panelToolName, type QueryFn } from './claudeAgent.ts';
import { AssistantSettingsStore } from './settings.ts';
import { AgentStore } from './store.ts';

let dir: string;
let store: AgentStore;
let settings: AssistantSettingsStore;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'claude-agent-'));
  const db = openDb(path.join(dir, 'app.db'));
  db.prepare("INSERT INTO users (id, email, password_hash, created_at) VALUES ('local', 'local', '', ?)").run(new Date().toISOString());
  store = new AgentStore(db);
  settings = new AssistantSettingsStore(db, path.join(dir, 'connector.key'), { builtIn: false, agents: true });
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const req = (message: string): AgentTurnRequest => ({ message, context: { page: 'home' } });

/** A query that answers with these SDK messages, and records what it was asked. */
function stubQuery(messages: unknown[], seen: { prompt?: unknown[]; options?: Record<string, unknown> } = {}): QueryFn {
  return ({ prompt, options }) => {
    seen.options = options;
    return (async function* () {
      seen.prompt = [];
      for await (const m of prompt) seen.prompt.push(m);
      for (const m of messages) yield m as never;
    })();
  };
}

const appTool = (name: string) => `mcp__${APP_SERVER}__${name}`;

describe('ClaudeAgentDriver', () => {
  it('streams the agent’s words and tool calls to the panel, and keeps them for the transcript', async () => {
    const seen: { prompt?: unknown[]; options?: Record<string, unknown> } = {};
    const groups: (string | null)[] = [];
    const driver = new ClaudeAgentDriver({
      cwd: () => '/folder',
      mcp: () => ({ url: 'http://127.0.0.1:1/mcp', token: 'secret' }),
      pinGroup: (g) => groups.push(g),
      executable: '/bin/claude',
      query: stubQuery(
        [
          { type: 'system', subtype: 'init', session_id: 'sess-1' },
          { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Adding ' } } },
          { type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'it.' } } },
          // A subagent's words are not the conversation.
          { type: 'stream_event', parent_tool_use_id: 'task-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'ignored' } } },
          { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Adding it.' }] } },
          { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't1', name: appTool('write_range'), input: { start: 'A1', rows: [[1]] } }] } },
          { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"cells":1}' }] }] } },
          { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'ls' } }] } },
          { type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'denied', is_error: true }] } },
          { type: 'result', subtype: 'success', result: 'Done.' },
        ],
        seen,
      ),
    });
    const conv = store.active('local', 'claude-agent');
    const events: AgentEvent[] = [];
    await driver.run(conv, store, req('Fill in A1'), (e) => events.push(e), new AbortController().signal);

    expect(events).toEqual([
      { type: 'text', text: 'Adding ' },
      { type: 'text', text: 'it.' },
      { type: 'tool_start', id: 't1', name: 'write_range', input: { start: 'A1', rows: [[1]] } },
      { type: 'tool_end', id: 't1', ok: true },
      { type: 'tool_start', id: 't2', name: 'Bash', input: { command: 'ls' } },
      { type: 'tool_end', id: 't2', ok: false },
      { type: 'done' },
    ]);
    // Run on the user's claude, in the folder, with the app's MCP server and not the plugin's copy of it.
    expect(seen.options).toMatchObject({
      cwd: '/folder',
      pathToClaudeCodeExecutable: '/bin/claude',
      mcpServers: { [APP_SERVER]: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer secret' } } },
      disallowedTools: ['mcp__plugin_mcp-docs_mcp-docs'],
      includePartialMessages: true,
      permissionMode: 'auto',
    });
    expect(seen.options).not.toHaveProperty('resume');
    expect((seen.prompt![0] as { message: { content: { text: string }[] } }).message.content.at(-1)).toEqual({ type: 'text', text: 'Fill in A1' });
    // One undo step for the turn's edits, then back to grouping by time.
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatch(/^agent-/);
    expect(groups[1]).toBeNull();

    // The session is kept, and resumed next time.
    expect(store.active('local', 'claude-agent').sessionId).toBe('sess-1');
    await driver.run(store.active('local', 'claude-agent'), store, req('More'), () => {}, new AbortController().signal);
    expect(seen.options).toMatchObject({ resume: 'sess-1' });
  });

  it('allows the app’s own tools, and asks the user about the agent’s other tools', async () => {
    let canUseTool: ((name: string, input: Record<string, unknown>, o: { signal: AbortSignal; title?: string }) => Promise<{ behavior: string }>) | undefined;
    let release: () => void = () => {};
    const driver = new ClaudeAgentDriver({
      cwd: () => '/folder',
      mcp: () => ({ url: 'u', token: 't' }),
      executable: '/bin/claude',
      query: ({ options }) => {
        canUseTool = options.canUseTool as typeof canUseTool;
        return (async function* () {
          await new Promise<void>((r) => (release = r));
          yield { type: 'result', subtype: 'success' } as never;
        })();
      },
    });
    const events: AgentEvent[] = [];
    const turn = driver.run(store.active('local', 'claude-agent'), store, req('Go'), (e) => events.push(e), new AbortController().signal);
    await vi.waitFor(() => expect(canUseTool).toBeDefined());
    const signal = new AbortController().signal;
    expect(await canUseTool!(appTool('delete_rows'), { from_row: 2, to_row: 2 }, { signal })).toMatchObject({ behavior: 'allow' });

    const asked = canUseTool!('Bash', { command: 'rm -rf build' }, { signal, title: 'Claude wants to run rm -rf build' });
    await vi.waitFor(() => expect(events.some((e) => e.type === 'permission')).toBe(true));
    const question = events.find((e) => e.type === 'permission') as Extract<AgentEvent, { type: 'permission' }>;
    expect(question.question).toBe('Claude wants to run rm -rf build');
    expect(driver.answerPermission(question.id, false)).toBe(true);
    expect(await asked).toMatchObject({ behavior: 'deny' });
    expect(driver.answerPermission(question.id, true)).toBe(false);
    release();
    await turn;
  });

  it('names the app’s tools plainly for the panel', () => {
    expect(panelToolName(appTool('format_range'))).toBe('format_range');
    expect(panelToolName('WebSearch')).toBe('WebSearch');
  });
});

describe('the assistant on the user’s own Claude Code', () => {
  it('runs the turns of a user who chose it, with no key, in a conversation of its own', async () => {
    const driver = new ClaudeAgentDriver({ cwd: () => '/f', mcp: () => ({ url: 'u', token: 't' }), executable: '/bin/claude', query: stubQuery([{ type: 'result', subtype: 'success' }]) });
    const agent = new AgentService(store, {} as SheetStore, settings, { jobs: false, claudeAgent: driver });

    // Without a key, the built-in loop has nothing to run on.
    expect(() => agent.checkTurn('local', req('Hi'))).toThrow(/API key/);
    await settings.update('local', { provider: 'claude-agent' }, async () => {});
    expect(settings.get('local')).toMatchObject({ provider: 'claude-agent', agents: true });
    expect(() => agent.checkTurn('local', req('Hi'))).not.toThrow();

    const events: AgentEvent[] = [];
    await agent.runTurn('local', req('Hi'), (e) => events.push(e), new AbortController().signal);
    expect(events).toEqual([{ type: 'done' }]);
    expect(agent.transcript('local')).toEqual([{ kind: 'user', text: 'Hi' }]);

    // Back on a key: a new conversation, since the agent's history is its own.
    await settings.update('local', { provider: 'anthropic', anthropicKey: 'sk-ant-test' }, async () => {});
    expect(agent.transcript('local')).toEqual([]);
  });

  it('is not offered where there is no agent to run', async () => {
    const hosted = new AssistantSettingsStore(openDb(path.join(dir, 'other.db')), path.join(dir, 'other.key'));
    await expect(hosted.update('local', { provider: 'claude-agent' }, async () => {})).rejects.toThrow(/desktop app/);
    expect(hosted.get('local').agents).toBe(false);
  });
});
