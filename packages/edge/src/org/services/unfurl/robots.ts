// Phase 11 §3: robots.txt, cached per origin for 24h. On any fetch failure we
// ALLOW — a site whose robots.txt is briefly 500ing shouldn't lose its cards.
import { guardedFetch } from './fetcher.js';
import { USER_AGENT } from './fetcher.js';

const ROBOTS_TTL_MS = 24 * 60 * 60 * 1000;
/** The token we match against `User-agent:` lines. */
const BOT_TOKEN = 'flow-linkexpanding';

interface RobotsEntry {
  rules: Rule[];
  expiresAt: number;
}
interface Rule {
  allow: boolean;
  path: string;
}

const cache = new Map<string, RobotsEntry>();

/** Exposed for tests and for the worker's shutdown path. */
export function clearRobotsCache(): void {
  cache.clear();
}

/**
 * Parse robots.txt, keeping only the groups that apply to us: an exact match
 * on our token wins outright; otherwise `*`. Later groups for the same agent
 * accumulate, matching how crawlers read the file in practice.
 */
export function parseRobots(text: string, token = BOT_TOKEN): Rule[] {
  const lines = text.split(/\r?\n/);
  const groups = new Map<string, Rule[]>();
  let currentAgents: string[] = [];
  let sawDirective = false;

  for (const raw of lines) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // A new agent line after directives starts a fresh group.
      if (sawDirective) {
        currentAgents = [];
        sawDirective = false;
      }
      currentAgents.push(value.toLowerCase());
      continue;
    }
    if (field !== 'allow' && field !== 'disallow') continue;
    sawDirective = true;
    for (const agent of currentAgents) {
      const rules = groups.get(agent) ?? [];
      rules.push({ allow: field === 'allow', path: value });
      groups.set(agent, rules);
    }
  }
  return groups.get(token) ?? groups.get('*') ?? [];
}

/**
 * Longest-match wins; Allow beats Disallow at equal length (the de-facto
 * standard). An empty `Disallow:` means "allow everything".
 */
export function isAllowedByRules(rules: Rule[], path: string): boolean {
  let best: { allow: boolean; length: number } | null = null;
  for (const rule of rules) {
    if (rule.path === '') {
      // "Disallow:" with no value is an explicit allow-all; ignore as a match.
      continue;
    }
    if (!pathMatches(rule.path, path)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.allow)) {
      best = { allow: rule.allow, length };
    }
  }
  return best ? best.allow : true;
}

/** Supports the two wildcards crawlers actually honour: `*` and `$`. */
function pathMatches(pattern: string, path: string): boolean {
  if (!pattern.includes('*') && !pattern.includes('$')) return path.startsWith(pattern);
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  const anchored = escaped.endsWith('\\$') ? `^${escaped.slice(0, -2)}$` : `^${escaped}`;
  try {
    return new RegExp(anchored).test(path);
  } catch {
    return false;
  }
}

/** §3: may we fetch this URL? Failure to read robots.txt allows. */
export async function isAllowed(url: string, deadline?: number): Promise<boolean> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  const origin = target.origin;
  const now = Date.now();
  const hit = cache.get(origin);
  let rules: Rule[];
  if (hit && hit.expiresAt > now) {
    rules = hit.rules;
  } else {
    try {
      const res = await guardedFetch(`${origin}/robots.txt`, {
        accept: 'text/plain,*/*;q=0.8',
        maxBytes: 64 * 1024,
        deadline,
      });
      // 4xx/5xx or anything unreadable → no rules → allowed.
      rules = res.status >= 200 && res.status < 300 ? parseRobots(res.body) : [];
    } catch {
      rules = [];
    }
    cache.set(origin, { rules, expiresAt: now + ROBOTS_TTL_MS });
  }
  return isAllowedByRules(rules, `${target.pathname}${target.search}`);
}

export { BOT_TOKEN, USER_AGENT };
