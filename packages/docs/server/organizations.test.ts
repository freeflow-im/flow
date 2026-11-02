// The app hosted in the FreeFlow suite with organizations (server/scope.ts; docs/specs/freeflow-suite.md §2.4): a
// stand-in host says who is signed in and who is in which organization; the routes and the assistant's server tools
// take the root they are asked for, or the file's.
import type Anthropic from '@anthropic-ai/sdk';
import Fastify from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AgentEvent, AgentTurnRequest } from '../shared/agent/protocol.ts';
import type { ModelCall } from './agent/agent.ts';
import { buildApp } from './app.ts';

type Block = Anthropic.Beta.BetaContentBlock;
const replies: Block[][] = [];
const requests: Parameters<ModelCall>[0][] = [];
const fakeModel: ModelCall = async (params) => {
  requests.push(structuredClone(params));
  const content = replies.shift() ?? [];
  return { id: 'm', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } as unknown as Anthropic.Beta.BetaMessage;
};

const members: Record<string, string[]> = { alice: ['harbor', 'juniper'], bob: ['harbor'], dave: [] };
let dir: string;
let host: ReturnType<typeof Fastify>;

beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'docs-orgs-'));
  host = Fastify();
  await buildApp({
    dataDir: dir,
    blob: null,
    pdf: null,
    agent: { model: fakeModel, jobs: false },
    host: {
      app: host,
      basePath: '/workspace',
      authenticate: async (req) => {
        const id = req.headers['x-user'];
        return typeof id === 'string' && id in members ? { id, email: `${id}@x.test` } : null;
      },
      signOut: async () => {},
      userForCookie: async () => null,
      isMember: async (userId, workspaceId) => members[userId]?.includes(workspaceId) ?? false,
      organizationsOf: async (userId) => (members[userId] ?? []).map((id) => ({ id, name: id })),
    },
  });
  await host.ready();
});

afterAll(async () => {
  await host.close();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (who: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) => {
  const res = await host.inject({ method, url, headers: { 'x-user': who }, ...(payload ? { payload } : {}) });
  return { status: res.statusCode, body: res.json() as Record<string, any> };
};
const turn = async (who: string, body: AgentTurnRequest): Promise<AgentEvent[]> => {
  const res = await host.inject({ method: 'POST', url: '/api/agent/turn', headers: { 'x-user': who }, payload: body });
  return res.payload.split('\n\n').filter((c: string) => c.startsWith('data: ')).map((c: string) => JSON.parse(c.slice(6)) as AgentEvent);
};
/** The tool result the model was handed after it called `list_docs`. */
const listedByAssistant = async (who: string, body: AgentTurnRequest): Promise<string[]> => {
  replies.push([{ type: 'tool_use', id: 't1', name: 'list_docs', input: {} } as Block], [{ type: 'text', text: 'Done.', citations: null } as Block]);
  requests.length = 0;
  await turn(who, body);
  const result = JSON.stringify(requests[1].messages.at(-1)!.content);
  return ['Private plan', 'Team plan', 'Juniper notes'].filter((t) => result.includes(t));
};

describe('organization files in the hosted app', () => {
  let team = '';
  let mine = '';

  it('lists each root and refuses an organization the user is not in', async () => {
    mine = (await call('alice', 'POST', '/api/docs', { title: 'Private plan', workspace: 'harbor' })).body.doc.id;
    team = (await call('alice', 'POST', '/api/docs', { title: 'Team plan', workspace: 'harbor', shared: true })).body.doc.id;
    await call('alice', 'POST', '/api/docs', { title: 'Juniper notes', workspace: 'juniper' });
    expect((await call('bob', 'GET', '/api/library?workspace=harbor&shared=1')).body.docs.map((d: { title: string }) => d.title)).toEqual(['Team plan']);
    expect((await call('bob', 'GET', '/api/library?workspace=harbor')).body.docs).toEqual([]);
    expect((await call('dave', 'GET', '/api/library?workspace=harbor&shared=1')).status).toBe(403);
    expect((await call('bob', 'GET', `/api/docs/${mine}`)).status).toBe(404);
    expect((await call('bob', 'GET', `/api/docs/${team}`)).status).toBe(200);
  });

  it("the home chat's tools see the user's files in the organization the bar selected", async () => {
    expect(await listedByAssistant('alice', { message: 'What do I have?', context: { page: 'home' }, workspace: 'harbor' })).toEqual(['Private plan']);
    expect(await listedByAssistant('alice', { message: 'And here?', context: { page: 'home' }, workspace: 'juniper' })).toEqual(['Juniper notes']);
  });

  it("an organization file's chat sees the organization's files", async () => {
    expect(await listedByAssistant('bob', { message: 'What else is shared?', context: { page: 'doc', docId: team, title: 'Team plan' } as AgentTurnRequest['context'] })).toEqual(['Team plan']);
  });

  it('a picture uploaded in an organization is its members’ to see', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    const res = await host.inject({ method: 'POST', url: '/api/images?workspace=harbor', headers: { 'x-user': 'alice', 'content-type': 'image/png' }, payload: png });
    const url = res.json().url as string;
    expect((await host.inject({ method: 'GET', url, headers: { 'x-user': 'bob' } })).statusCode).toBe(200);
    expect((await host.inject({ method: 'GET', url, headers: { 'x-user': 'dave' } })).statusCode).toBe(404);
  });

  it('moves a folder with its files between the roots', async () => {
    await call('alice', 'POST', '/api/folders', { name: 'Drafts', workspace: 'harbor' });
    const draft = (await call('alice', 'POST', '/api/markdown', { title: 'Draft', text: '# Draft', folder: 'Drafts', workspace: 'harbor' })).body.doc.id;
    expect((await call('bob', 'GET', `/api/markdown/${draft}`)).status).toBe(404);
    const moved = await call('alice', 'POST', '/api/folders/scope', { path: 'Drafts', from: { workspace: 'harbor' }, workspace: 'harbor', shared: true });
    expect(moved.body).toMatchObject({ folder: { path: 'Drafts' }, moved: 1 });
    expect((await call('bob', 'GET', '/api/library?workspace=harbor&shared=1&folder=Drafts')).body.docs.map((d: { id: string }) => d.id)).toEqual([draft]);
  });
});
