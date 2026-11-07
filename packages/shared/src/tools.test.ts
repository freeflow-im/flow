import { describe, expect, it } from 'vitest';
import { APP_MANIFESTS } from './manifests.js';
import { allowedBy, grantedScopes, runsInApp, TOOL_DEFINITIONS, TOOL_DOORS, toolsAtDoor } from './tools.js';

const manifest = (name: string) => APP_MANIFESTS.find((m) => m.name === name);
const declared = (app: string) => new Set((manifest(app)?.scopes ?? []).flatMap((g) => g.scopes));

describe('TOOL_DEFINITIONS', () => {
  it('names each tool once at each door', () => {
    for (const door of TOOL_DOORS) {
      const names = toolsAtDoor(door).map((t) => t.name);
      expect(new Set(names).size, door).toBe(names.length);
    }
    for (const t of TOOL_DEFINITIONS) {
      expect(t.doors.length, t.name).toBeGreaterThan(0);
      expect(new Set(t.doors).size).toBe(t.doors.length);
      for (const d of t.doors) expect(TOOL_DOORS).toContain(d);
    }
  });

  it('gives every tool an app with a manifest, which names it', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(manifest(t.app), `${t.name}: ${t.app}`).toBeTruthy();
      expect(manifest(t.app)!.tools ?? [], `${t.app} lists ${t.name}`).toContain(t.name);
    }
    for (const m of APP_MANIFESTS) expect(m.tools ?? []).toEqual([...new Set(TOOL_DEFINITIONS.filter((t) => t.app === m.name).map((t) => t.name))]);
  });

  it('asks only for scopes the manifests declare, at least one of them its own app’s', () => {
    const all = new Set(APP_MANIFESTS.flatMap((m) => [...declared(m.name)]));
    for (const t of TOOL_DEFINITIONS) {
      for (const s of t.scopes) expect(all.has(s), `${t.name}: ${s}`).toBe(true);
      if (t.scopes.length) expect(t.scopes.some((s) => declared(t.app).has(s)), t.name).toBe(true);
    }
    // /mcp checks scopes: each of its tools names some.
    for (const t of toolsAtDoor('mcp')) expect(t.scopes.length, t.name).toBeGreaterThan(0);
  });

  it('keeps browser tools to the assistant, in apps with a client', () => {
    for (const t of TOOL_DEFINITIONS.filter((x) => x.kind === 'browser')) {
      expect(t.doors, t.name).toEqual(['assistant']);
      for (const app of [t.app, ...(t.runsIn ?? [])]) expect(manifest(app)?.client, `${t.name} in ${app}`).toBeTruthy();
    }
    expect(TOOL_DEFINITIONS.filter((t) => t.runsIn).every((t) => t.kind === 'browser')).toBe(true);
  });

  it('describes every tool and its input', () => {
    for (const t of TOOL_DEFINITIONS) {
      expect(t.description.length, t.name).toBeGreaterThan(10);
      expect(t.input.type, t.name).toBe('object');
      expect(t.name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it('grants writing files and calendars with reading them', () => {
    expect([...grantedScopes(['files:write'])].sort()).toEqual(['files:read', 'files:write']);
    expect(grantedScopes(['calendar:write']).has('calendar:read')).toBe(true);
    expect(grantedScopes(['mail:write']).has('mail:read')).toBe(false);
    const save = toolsAtDoor('mcp').find((t) => t.name === 'save_mail_attachment_to_docs')!;
    expect(allowedBy(save, grantedScopes(['mail:read']))).toBe(false);
    expect(allowedBy(save, grantedScopes(['mail:read', 'files:write']))).toBe(true);
    const del = toolsAtDoor('assistant').find((t) => t.name === 'delete_event')!;
    expect(runsInApp(del, 'calendar') && runsInApp(del, 'docs') && !runsInApp(del, 'mail')).toBe(true);
  });
});
