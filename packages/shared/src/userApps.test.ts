import { describe, expect, it } from 'vitest';
import { appEventType, appOfEventType, appToolName, checkHostedFiles, checkUserAppManifest, parseAppToolName, RESERVED_APP_NAMES } from './userApps.js';

const taskboard = () => ({
  name: 'taskboard',
  label: 'Tasks',
  icon: '🗂️',
  scopes: [
    { id: 'taskboard:read', label: 'See tasks', read: true },
    { id: 'taskboard:write', label: 'Change tasks' },
  ],
  tools: [
    { name: 'list_tasks', description: 'Find tasks.', input: { type: 'object', properties: { status: { type: 'string' } } }, scopes: ['taskboard:read'] },
    { name: 'claim_task', description: 'Claim a task.', input: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] }, scopes: ['taskboard:write'] },
  ],
  events: ['task.assigned', 'task.created'],
  server: { url: 'https://tasks.example.com/freeflow' },
  ui: { url: 'https://tasks.example.com/' },
});

const problems = (m: unknown, opts = {}) => {
  const r = checkUserAppManifest(m, opts);
  return r.ok ? [] : r.problems;
};

describe('checkUserAppManifest', () => {
  it('accepts the Taskboard manifest', () => {
    const r = checkUserAppManifest(taskboard());
    expect(r.ok).toBe(true);
  });

  it('refuses built-in and reserved names', () => {
    for (const name of ['docs', 'chat', 'admin', 'apps', 'dev', 'files', 'events']) {
      expect(RESERVED_APP_NAMES.has(name)).toBe(true);
      expect(problems({ ...taskboard(), name, scopes: [{ id: `${name}:read`, label: 'x', read: true }], tools: [] })).toContain(`name: "${name}" is reserved`);
    }
  });

  it('refuses a name with an underscore or capitals', () => {
    expect(problems({ ...taskboard(), name: 'task_board' })[0]).toMatch(/^name:/);
    expect(problems({ ...taskboard(), name: 'Taskboard' })[0]).toMatch(/^name:/);
  });

  it('lists every problem at once', () => {
    const m = taskboard();
    m.tools.push({ name: 'bad__name', description: 'x', input: { type: 'object' }, scopes: ['taskboard:claim'] } as never);
    const p = problems(m);
    expect(p).toContain('tools.bad__name: scope "taskboard:claim" is not declared in scopes');
    expect(p.some((x) => x.startsWith('tools: "bad__name"'))).toBe(true);
  });

  it('refuses uses and egress on an external app', () => {
    const p = problems({ ...taskboard(), uses: ['docs:read'], egress: ['api.example.com'] });
    expect(p.some((x) => x.startsWith('uses:'))).toBe(true);
    expect(p.some((x) => x.startsWith('egress:'))).toBe(true);
  });

  it('needs https unless told otherwise', () => {
    const m = { ...taskboard(), server: { url: 'http://localhost:8790/freeflow' } };
    expect(problems(m)).toContain('server.url: must be https');
    expect(problems(m, { allowHttp: true })).toEqual([]);
  });

  it('needs scopes named after the app', () => {
    expect(problems({ ...taskboard(), scopes: [{ id: 'docs:read', label: 'x', read: true }], tools: [] })).toContain('scopes: "docs:read" must be "taskboard:<word>"');
  });

  it('needs a read scope when the app has events', () => {
    const m = { ...taskboard(), scopes: [{ id: 'taskboard:write', label: 'x' }], tools: [] };
    expect(problems(m).some((x) => x.includes('"read": true'))).toBe(true);
  });

  it('refuses unknown fields', () => {
    expect(problems({ ...taskboard(), routes: 'x' }).length).toBeGreaterThan(0);
  });
});

describe('names', () => {
  it('joins and splits tool names', () => {
    expect(appToolName('taskboard', 'claim_task')).toBe('taskboard__claim_task');
    expect(parseAppToolName('taskboard__claim_task')).toEqual({ app: 'taskboard', tool: 'claim_task' });
    expect(parseAppToolName('send_message')).toBeNull();
    expect(parseAppToolName('__x')).toBeNull();
  });

  it('the longest name fits the model APIs', () => {
    expect(`dev__${appToolName('a'.repeat(20), 'b'.repeat(32))}`.length).toBeLessThanOrEqual(64);
  });

  it('names events', () => {
    expect(appEventType('taskboard', 'task.assigned')).toBe('app.taskboard.task.assigned');
    expect(appOfEventType('app.taskboard.task.assigned')).toBe('taskboard');
    expect(appOfEventType('chat.message.created')).toBeNull();
  });
});

describe('hosted apps (user-apps.md §7.2, phase 2)', () => {
  const hosted = () => ({ ...taskboard(), server: { hosted: true }, ui: { hosted: true }, uses: ['docs:read'], egress: ['api.example.com'] });

  it('accepts a hosted manifest with uses and egress', () => {
    expect(problems(hosted())).toEqual([]);
  });

  it('refuses an unknown use and a bad host', () => {
    expect(problems({ ...hosted(), uses: ['mail:send'] }).length).toBeGreaterThan(0);
    expect(problems({ ...hosted(), egress: ['https://api.example.com/x'] })).toContain('egress: "https://api.example.com/x" must be a host name, such as api.example.com');
  });

  it('refuses a hosted screen on an external server', () => {
    expect(problems({ ...taskboard(), ui: { hosted: true } })).toContain('ui: only a hosted app has a hosted screen (user-apps.md §7.1)');
  });

  it("checks a version's files", () => {
    const m = checkUserAppManifest(hosted());
    if (!m.ok) throw new Error('manifest');
    expect(checkHostedFiles(m.manifest, { 'server.js': 100, 'ui/index.html': 50, 'ui/app.js': 10, 'migrations/0001_tasks.sql': 20 })).toEqual([]);
    const p = checkHostedFiles(m.manifest, { 'ui/app.js': 10, '../x': 1, 'migrations/1.sql': 1 });
    expect(p).toContain('files: server.js is missing');
    expect(p).toContain('files: ui/index.html is missing, and the manifest has a hosted screen');
    expect(p.filter((x) => x.includes('is not server.js'))).toHaveLength(2);
    expect(checkHostedFiles(m.manifest, { 'server.js': 6_000_000, 'ui/index.html': 1 })[0]).toMatch(/over the 5000000/);
  });
});
