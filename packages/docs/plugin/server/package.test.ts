// The package uploaded to ChatGPT (plugin.json, mcp.json, skills/, assets/): what the submission portal checks,
// checked here first.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const root = path.join(import.meta.dirname, '..');
const manifest = JSON.parse(readFileSync(path.join(root, 'plugin.json'), 'utf8'));
const ui = manifest.extensions['com.openai'].interface as Record<string, unknown>;

/** The `name: value` lines of a skill's front matter (one line each, which is all a skill here uses). */
function frontMatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!m) throw new Error('No front matter');
  return Object.fromEntries(
    m[1].split('\n').map((line) => {
      const kv = /^([a-z][\w-]*): (.+)$/.exec(line);
      if (!kv) throw new Error(`Front matter line is not "key: value": ${line.slice(0, 60)}`);
      const quoted = /^"(.*)"$/.exec(kv[2]);
      // An unquoted value holding ": " is not what it looks like in YAML.
      if (!quoted && /: /.test(kv[2])) throw new Error(`Quote the value of ${kv[1]}: it holds a colon`);
      return [kv[1], quoted ? quoted[1] : kv[2]];
    }),
  );
}

describe('plugin package', () => {
  it('has a listing within the limits of the submission', () => {
    expect(manifest.name).toMatch(/^[a-z0-9-]+$/);
    expect(manifest.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(String(ui.displayName).length).toBeLessThanOrEqual(30);
    expect(String(ui.shortDescription).length).toBeLessThanOrEqual(30);
    expect(String(ui.longDescription).length).toBeLessThanOrEqual(4000);
    expect(String(ui.developerName).length).toBeLessThanOrEqual(80);
    expect(ui.category).toBeTruthy();
    const capabilities = ui.capabilities as string[];
    expect(capabilities.length).toBeLessThanOrEqual(20);
    for (const c of capabilities) expect(c.length).toBeLessThanOrEqual(120);
    const prompts = ui.defaultPrompt as string[];
    expect(prompts.length).toBeLessThanOrEqual(3);
    for (const p of prompts) expect(p.length).toBeLessThanOrEqual(128);
    expect(ui.brandColor).toMatch(/^#[0-9A-F]{6}$/i);
    for (const key of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) if (ui[key] !== undefined) expect(ui[key]).toMatch(/^https:\/\/[^@]+$/);
  });

  it('includes every file it refers to', () => {
    const refs = [ui.logo, ui.composerIcon, ...((ui.screenshots as string[] | undefined) ?? []), manifest.extensions['com.openai'].onboardingSkill].filter(Boolean) as string[];
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(ref.startsWith('./')).toBe(true);
      expect(existsSync(path.join(root, ref))).toBe(true);
    }
    expect(readFileSync(path.join(root, String(ui.logo)), 'utf8')).toMatch(/viewBox="0 0 (\d+) \1"/);
  });

  it('names one remote MCP server, signed in to with OAuth, and holds no secrets', () => {
    const text = readFileSync(path.join(root, 'mcp.json'), 'utf8');
    const servers = Object.values(JSON.parse(text).mcpServers) as { type: string; url: string; headers?: unknown; extensions?: { 'com.openai'?: { auth?: { type: string } } } }[];
    expect(servers).toHaveLength(1);
    expect(servers[0].type).toBe('streamable-http');
    expect(servers[0].url).toMatch(/^https:\/\/[^/]+\/mcp$/);
    expect(servers[0].headers).toBeUndefined();
    expect(servers[0].extensions?.['com.openai']?.auth?.type).toBe('oauth');
    expect(text).not.toMatch(/secret/i);
  });

  it('holds skills named as their folders, with front matter a YAML reader takes', () => {
    const skills = readdirSync(path.join(root, 'skills'));
    expect(skills.length).toBeGreaterThan(0);
    expect(skills.length).toBeLessThanOrEqual(5);
    for (const dir of skills) {
      const text = readFileSync(path.join(root, 'skills', dir, 'SKILL.md'), 'utf8');
      const fm = frontMatter(text);
      expect(fm.name).toBe(dir);
      expect(fm.description.length).toBeGreaterThan(20);
      expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
    }
  });
});
