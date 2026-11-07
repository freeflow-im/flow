import { describe, expect, it } from 'vitest';
import { APP_MANIFESTS } from './manifests.js';
import { APP_SCOPES } from './platform.js';

const unique = (xs: string[]) => new Set(xs).size === xs.length;

describe('APP_MANIFESTS', () => {
  it('names each app once, and each path, object and client once', () => {
    expect(unique(APP_MANIFESTS.map((m) => m.name))).toBe(true);
    expect(unique(APP_MANIFESTS.flatMap((m) => (m.path ? [m.path] : [])))).toBe(true);
    expect(unique(APP_MANIFESTS.flatMap((m) => (m.object ? [m.object.className] : [])))).toBe(true);
    expect(unique(APP_MANIFESTS.flatMap((m) => (m.client ? [m.client.basePath] : [])))).toBe(true);
    for (const m of APP_MANIFESTS) expect(APP_SCOPES).toContain(m.scope);
  });

  it('gives each tab its own shortcut, ⌘1 onwards with none skipped, the first four Docs, Chat, Mail and Calendar', () => {
    const tabs = APP_MANIFESTS.flatMap((m) => (m.tab ? [m.tab] : []));
    expect(unique(tabs.map((t) => t.shortcut))).toBe(true);
    expect(unique(tabs.map((t) => t.label))).toBe(true);
    for (const t of tabs) expect(t.shortcut).toMatch(/^[1-9]$/);
    const ordered = [...tabs].sort((a, b) => a.shortcut.localeCompare(b.shortcut));
    expect(ordered.map((t) => t.shortcut)).toEqual(ordered.map((_, i) => String(i + 1)));
    expect(ordered.slice(0, 4).map((t) => t.label)).toEqual(['Docs', 'Chat', 'Mail', 'Calendar']);
    // A tab goes to a page, so an app with one has a path.
    for (const m of APP_MANIFESTS) if (m.tab) expect(m.path).toBeTruthy();
  });

  it('names each assistant page once, so a turn’s page names one app', () => {
    const pages = APP_MANIFESTS.flatMap((m) => m.assistant?.pages ?? []);
    expect(unique(pages)).toBe(true);
    expect(pages).toEqual(expect.arrayContaining(['home', 'mail', 'calendar']));
  });

  it('names every event type <app>.<type>', () => {
    for (const m of APP_MANIFESTS) {
      expect(unique(m.events)).toBe(true);
      for (const type of m.events) expect(type).toMatch(new RegExp(`^${m.name}(\\.[a-z][a-z_]*)+$`));
    }
  });

  it('serves each page under its own app’s path, from one page per app', () => {
    for (const m of APP_MANIFESTS) {
      if (!m.pages) continue;
      expect(m.client).toBeDefined();
      expect(new Set(m.pages.map((p) => p.html)).size).toBe(1);
      for (const p of m.pages) {
        if (m.path === '/') expect(p.path).toBe('*');
        else expect(p.path === m.path || p.path.startsWith(`${m.path}/`)).toBe(true);
      }
    }
    expect(unique(APP_MANIFESTS.flatMap((m) => m.pages ?? []).map((p) => p.path))).toBe(true);
  });

  it('gives each consent group its own id and each scope one group', () => {
    const groups = APP_MANIFESTS.flatMap((m) => m.scopes ?? []);
    expect(unique(groups.map((g) => g.id))).toBe(true);
    expect(unique(groups.flatMap((g) => g.scopes))).toBe(true);
    for (const g of groups) for (const s of g.scopes) expect(s).toMatch(/^[a-z]+:[a-z]+$/);
    // Sending as the person is off until they tick it, and says why.
    const send = groups.find((g) => g.id === 'send');
    expect(send?.checkedByDefault).toBe(false);
    expect(send?.warning).toBeTruthy();
  });
});
