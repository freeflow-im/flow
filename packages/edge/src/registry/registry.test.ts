// The registry against the tools as they are implemented (platform.md §5.4). @flow/shared's definitions are written from
// the implementations here: /mcp's tools as the MCP SDK lists them (Docs' from the plugin's server, Mail's, Calendar's and
// Events' from their modules), the assistant's from its Zod schemas, and the bridge's from its built-in list. When they
// drift apart this fails; `UPDATE_TOOL_DEFINITIONS=1 pnpm --filter @flow/edge exec vitest run src/registry` writes them again
// (then rebuild @flow/shared).
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod4';
import { TOOL_DEFINITIONS, TOOL_DOORS, toolsAtDoor, type ToolDefinition, type ToolDoor } from '@flow/shared/tools';
import { createMcpServer, MCP_VERSIONS, type McpVersion } from '@flow/docs/plugin/server/mcp.ts';
import { TOOL_DEFS } from '@flow/docs/server/agent/tools.ts';
import { CLIENT_TOOLS } from '@flow/docs/shared/agent/protocol.ts';
import { ASSISTANT_MAIL_TOOLS, MAIL_TOOLS } from '../imap/mailTools.ts';
import { ASSISTANT_CALENDAR_TOOLS, CALENDAR_TOOLS } from '../calendar/calendarTools.ts';
import { EVENT_TOOLS } from '../events/eventTools.ts';
import { SCOPE_GROUPS } from '../directory/mcpOAuth.ts';
import { toolLabel } from '@flow/docs/client/src/agent/describe.ts';
import { BUILT_IN_TOOLS } from '../../../agent-bridge/src/mcp-server.ts';
import { CALENDAR_TOOL_NAMES } from '../../../agent-bridge/src/calendar-tools.ts';
import { MAIL_TOOL_NAMES } from '../../../agent-bridge/src/mail-tools.ts';
import { APP_MANIFESTS } from '@flow/shared/manifests';
import { registered, registrations, runnerOf, toolsFor } from './index.ts';
// Docs' own tools are registered by the suite's glue, as the Assistant object imports it; the suite's schemas sit beside Docs'.
import { SUITE_SCHEMAS } from '../docs/assistantTools.ts';

/** The apps whose tools this test reads from their own modules (above); every other app with tools was added by manifest
 * and registers them from its object module, src/<app>/object.ts, with their descriptions and scopes (apps.ts). */
const OWN_MODULES = new Set(['chat', 'docs', 'mail', 'calendar', 'events']);
const BY_MANIFEST = APP_MANIFESTS.filter((m) => m.tools?.length && !OWN_MODULES.has(m.name)).map((m) => m.name);
for (const app of BY_MANIFEST) await import(`../${app}/object.ts`);
/** Their registrations, by tool: the app and the doors. */
const manifestTools = () => {
  const out = new Map<string, { app: string; doors: ToolDoor[] }>();
  for (const r of registrations()) if (BY_MANIFEST.includes(r.app)) out.set(r.name, { app: r.app, doors: [...(out.get(r.name)?.doors ?? []), r.door] });
  return out;
};

type Input = ToolDefinition['input'];

/** The assistant's browser tools that ask the person first (confirmationFor in the Docs client, Calendar's delete_event). */
const CONFIRMED = new Set(['delete_event', 'request_app_change', 'edit_image', 'delete_tab', 'delete_rows', 'delete_columns', 'clear_range', 'delete_slides', 'delete_blocks', 'replace_blocks']);
/** Browser tools that other apps' pages run too. */
const RUNS_IN: Record<string, string[]> = { delete_event: ['docs'] };

/** /mcp's tools, as the newest version lists them with every scope. */
async function mcpTools(): Promise<{ name: string; description?: string; inputSchema: Input; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[]> {
  // A hub that can make PDFs, so export_pdf is listed (where the Worker cannot, the plugin's server leaves it out).
  const mcp = createMcpServer({ hub: { pdf: {} } } as never, { bundle: () => { throw new Error('no app'); }, publicUrl: null, level: 'tools', version: Math.max(...MCP_VERSIONS) as McpVersion, uploadUrl: 'https://app.test/mcp/import/o1', appUrl: 'https://app.test/docs' });
  for (const t of [...MAIL_TOOLS, ...CALENDAR_TOOLS, ...EVENT_TOOLS]) mcp.registerTool(t.name, { title: t.title, description: t.description, inputSchema: t.shape as never, annotations: t.annotations }, (async () => ({ content: [] })) as never);
  for (const [name, { app, doors }] of manifestTools()) {
    const r = registered(doors[0]!, app, name)!;
    mcp.registerTool(name, { title: r.title, description: r.description, inputSchema: r.shape as never, annotations: r.annotations }, (async () => ({ content: [] })) as never);
  }
  const [a, b] = InMemoryTransport.createLinkedPair();
  await mcp.connect(a);
  const client = new Client({ name: 'registry-test', version: '1' });
  await client.connect(b);
  const { tools } = await client.listTools();
  await client.close();
  return tools as never;
}

/** The definitions, from the implementations. The same tool at two doors is one definition when the doors tell it alike. */
async function fromImplementations(): Promise<ToolDefinition[]> {
  const mail = new Set(MAIL_TOOLS.map((t) => t.name)), calendar = new Set(CALENDAR_TOOLS.map((t) => t.name)), events = new Set(EVENT_TOOLS.map((t) => t.name));
  const scoped = new Map([...MAIL_TOOLS, ...CALENDAR_TOOLS, ...EVENT_TOOLS].map((t) => [t.name, t.scopes]));
  const rows: { door: ToolDoor; def: ToolDefinition }[] = [];
  const byManifest = manifestTools();
  for (const t of await mcpTools()) {
    const m = byManifest.get(t.name);
    if (m) {
      // An app added by manifest: one definition, at the doors it registered at, its input as /mcp lists it.
      const r = registered(m.doors[0]!, m.app, t.name)!;
      for (const door of m.doors) rows.push({ door, def: { name: t.name, app: m.app, kind: 'server', doors: [], scopes: r.scopes ?? [], ...(t.annotations?.destructiveHint === true ? { destructive: true } : {}), description: t.description ?? '', input: t.inputSchema } });
      continue;
    }
    const app = mail.has(t.name) ? 'mail' : calendar.has(t.name) ? 'calendar' : events.has(t.name) ? 'events' : 'docs';
    const scopes = app === 'docs' ? [t.annotations?.readOnlyHint === true ? 'files:read' : 'files:write'] : scoped.get(t.name)!;
    rows.push({ door: 'mcp', def: { name: t.name, app, kind: 'server', doors: [], scopes, ...(t.annotations?.destructiveHint === true ? { destructive: true } : {}), description: t.description ?? '', input: t.inputSchema } });
  }
  const assistantMail = new Set<string>([...ASSISTANT_MAIL_TOOLS, 'open_mail_message']), assistantCalendar = new Set<string>([...ASSISTANT_CALENDAR_TOOLS, 'open_calendar_event', 'show_calendar_range']);
  // The assistant's: Docs' own as its assistant sends them (JSON Schema from Docs' zod; this package's zod is another
  // instance, which would drop their descriptions), and the suite's converted here.
  const assistantTools = [
    ...TOOL_DEFS.map((d) => ({ name: d.name, description: String(d.description ?? ''), input: d.input_schema as unknown as Input })),
    ...Object.entries(SUITE_SCHEMAS).map(([name, schema]) => {
      const { $schema: _ignored, description, ...input } = z.toJSONSchema(schema) as Record<string, unknown>;
      return { name, description: String(description ?? ''), input: input as Input };
    }),
  ];
  for (const { name, description, input } of assistantTools) {
    const kind = CLIENT_TOOLS.has(name) ? 'browser' : 'server';
    const app = assistantMail.has(name) ? 'mail' : assistantCalendar.has(name) ? 'calendar' : 'docs';
    rows.push({ door: 'assistant', def: { name, app, kind, doors: [], scopes: [], ...(CONFIRMED.has(name) ? { confirm: true } : {}), ...(RUNS_IN[name] ? { runsIn: RUNS_IN[name] } : {}), description, input } });
  }
  for (const t of BUILT_IN_TOOLS) {
    const app = CALENDAR_TOOL_NAMES.has(t.name) ? 'calendar' : MAIL_TOOL_NAMES.has(t.name) ? 'mail' : 'chat';
    rows.push({ door: 'bridge', def: { name: t.name, app, kind: 'server', doors: [], scopes: [], description: t.description, input: t.inputSchema as Input } });
  }
  const merged = new Map<string, ToolDefinition>();
  for (const { door, def } of rows) {
    const k = JSON.stringify([def.app, def.name, def.kind, def.description, def.input]);
    const had = merged.get(k);
    if (!had) merged.set(k, { ...def, doors: [door] });
    else {
      had.doors.push(door);
      if (!had.scopes.length) had.scopes = def.scopes;
      if (def.destructive) had.destructive = true;
      if (def.confirm) had.confirm = true;
      if (def.runsIn) had.runsIn = def.runsIn;
    }
  }
  // Each definition's fields in one order, so the files read the same each time they are written.
  return [...merged.values()].map(({ name, app, kind, doors, scopes, destructive, confirm, runsIn, description, input }) => ({ name, app, kind, doors, scopes, ...(destructive ? { destructive } : {}), ...(confirm ? { confirm } : {}), ...(runsIn ? { runsIn } : {}), description, input }));
}

/** Each app's list of definitions, in the manifests' order: `<APP>_TOOLS` in @flow/shared's toolDefinitions/<app>.ts. */
const LISTS: Record<string, string> = Object.fromEntries(APP_MANIFESTS.filter((m) => m.tools?.length).map((m) => [m.name, `${m.name.toUpperCase()}_TOOLS`]));

function write(defs: ToolDefinition[]): void {
  for (const [app, list] of Object.entries(LISTS)) {
    const mine = defs.filter((d) => d.app === app);
    const body = mine.map((d) => `  ${JSON.stringify(d)},`).join('\n');
    const text = `// The ${app} app's tools (docs/specs/platform.md §5.4), written from their implementations by the Worker's registry test\n// (packages/edge/src/registry/registry.test.ts): run it with UPDATE_TOOL_DEFINITIONS=1 after changing a tool, not this file.\nimport type { ToolDefinition } from '../tools.js';\n\nexport const ${list}: ToolDefinition[] = [\n${body}\n];\n`;
    writeFileSync(fileURLToPath(new URL(`../../../shared/src/toolDefinitions/${app}.ts`, import.meta.url)), text);
  }
}

describe('the tool definitions', () => {
  it('are the tools as implemented, at every door', async () => {
    const defs = await fromImplementations();
    if (process.env.UPDATE_TOOL_DEFINITIONS) write(defs);
    else expect(TOOL_DEFINITIONS).toEqual(defs.sort((a, b) => Object.keys(LISTS).indexOf(a.app) - Object.keys(LISTS).indexOf(b.app)));
  }, 60_000);
});

describe('the registry', () => {
  it('runs every server tool of /mcp and the assistant, Docs’ /mcp tools aside (the plugin’s server runs them)', () => {
    for (const r of registrations()) expect(toolsAtDoor(r.door).some((t) => t.name === r.name && t.app === r.app && t.kind === 'server'), `${r.door} ${r.app} ${r.name}`).toBe(true);
    for (const t of toolsAtDoor('mcp')) if (t.app !== 'docs') expect(runnerOf('mcp', t.name), t.name).toBeTruthy();
    for (const t of toolsAtDoor('assistant')) if (t.kind === 'server') expect(runnerOf('assistant', t.name), t.name).toBeTruthy();
    for (const t of toolsAtDoor('assistant')) if (t.kind === 'browser') expect(runnerOf('assistant', t.name)).toBeUndefined();
  });

  it('gives /mcp the server tools whose scopes are all granted, of the apps the Worker reaches', () => {
    const names = (scopes: string[], reach: Record<string, unknown> = { mail: 1, calendar: 1, events: 1 }) => toolsFor('mcp', { scopes, reach }).map((t) => t.definition.name);
    expect(names(['files:read'])).toContain('read_range');
    expect(names(['files:read'])).not.toContain('write_range');
    expect(names(['files:write'])).toEqual(expect.arrayContaining(['read_range', 'write_range']));
    expect(names(['calendar:write'])).toEqual(expect.arrayContaining(['list_events', 'create_event']));
    expect(names(['mail:read'])).not.toContain('save_mail_attachment_to_docs');
    expect(names(['mail:read', 'files:write'])).toContain('save_mail_attachment_to_docs');
    expect(names(['mail:read', 'mail:write', 'mail:send'], {})).toEqual([]);
    expect(toolsFor('mcp', { scopes: TOOL_DEFINITIONS.flatMap((t) => t.scopes), reach: { mail: 1, calendar: 1, events: 1 } }).every((t) => t.definition.kind === 'server')).toBe(true);
  });

  it('gives the assistant every server tool and the open app’s browser tools', () => {
    const names = (app: string) => toolsFor('assistant', { app }).map((t) => t.definition.name);
    expect(names('docs')).toEqual(expect.arrayContaining(['write_range', 'read_doc', 'delete_event', 'search_mail', 'list_events', 'list_docs']));
    expect(names('docs')).not.toContain('open_mail_message');
    expect(names('docs')).not.toContain('show_calendar_range');
    expect(names('mail')).toEqual(expect.arrayContaining(['open_mail_message', 'search_mail', 'create_event', 'list_docs', 'find_files', 'read_stored_file']));
    expect(names('mail')).not.toContain('write_range');
    expect(names('mail')).not.toContain('delete_event');
    expect(names('calendar')).toEqual(expect.arrayContaining(['open_calendar_event', 'show_calendar_range', 'delete_event', 'read_mail']));
    expect(names('calendar')).not.toContain('read_range');
  });

  it('labels every tool the assistant has in the chat (describe.ts)', () => {
    for (const t of toolsAtDoor('assistant')) expect(toolLabel(t.name, {}), t.name).not.toBe(t.name);
  });

  it('asks for no scope the consent page does not offer', () => {
    const offered = new Set(SCOPE_GROUPS.flatMap((g) => g.scopes));
    for (const t of TOOL_DEFINITIONS) for (const s of t.scopes) expect(offered.has(s), `${t.name}: ${s}`).toBe(true);
  });

  it('serves each door', () => {
    for (const door of TOOL_DOORS) expect(toolsAtDoor(door).length).toBeGreaterThan(0);
  });
});
