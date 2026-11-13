// Built-in help docs (#383): markdown files checked into the repo at
// `docs/help/`, served raw over the API so every client renders them with its
// own markdown pipeline (web now, macOS in #384).
//
// The set of topics is derived from the directory — dropping in a new .md with
// front-matter makes it appear in every client with no client change. Files are
// read per request: there are a handful of them, and it means an edit shows up
// without a restart in dev.
//
// One topic has no file: "What's New" (#474) is generated from the same source
// as the build version menu — the `## Feature` sections of `changelog/`, via
// `scripts/build-features.mjs`. Serving it here rather than checking in a copy
// is the point: the help page and the version menu are the same text, and a
// release note is written once.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { HelpPageDTO, HelpTopicDTO } from '@flow/shared';
import { notFound } from '../lib/errors.js';

/** Repo-root `docs/help`. This file sits at packages/server/{src,dist}/services,
 * so four levels up is the repo root under tsx and under the compiled build
 * alike (the server's image keeps the repo layout and copies docs/help —
 * packages/server/deploy/aws/Dockerfile). */
const HELP_DIR =
  process.env.FLOW_HELP_DIR ??
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/help');

/** Repo root, resolved the same way as HELP_DIR above. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/** The generator behind FEATURES.md, imported for its `buildFeatures()`. */
const FEATURES_SCRIPT = path.join(REPO_ROOT, 'scripts/build-features.mjs');

/** Its output, written by the web pre(dev|build) — the fallback source. */
const FEATURES_MD = path.join(REPO_ROOT, 'FEATURES.md');

/** The generated topic. Ordered after the written pages, which teach the app. */
const WHATS_NEW: HelpTopicDTO = { slug: 'whats-new', title: "What's New", order: 90 };

/** A slug is a file name, so it must never be able to escape the help dir. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Minimal front-matter: a leading `---` block of `key: value` lines. Only
 * `title` and `order` are read; everything else is ignored. */
export function parseFrontMatter(source: string): { meta: Record<string, string>; body: string } {
  // Markdown parsing is line-oriented. Normalize files at this boundary so
  // checked-out Windows docs render exactly like their LF counterparts.
  const normalized = source.replace(/\r\n?/g, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(normalized);
  if (!match) return { meta: {}, body: normalized };
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const kv = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, '');
  }
  return { meta, body: normalized.slice(match[0].length) };
}

function readTopic(slug: string): { topic: HelpTopicDTO; body: string } | null {
  let source: string;
  try {
    source = fs.readFileSync(path.join(HELP_DIR, `${slug}.md`), 'utf8');
  } catch {
    return null;
  }
  const { meta, body } = parseFrontMatter(source);
  const order = Number.parseInt(meta.order ?? '', 10);
  return {
    topic: {
      slug,
      // A file with no `title:` still gets a usable one rather than vanishing.
      title: meta.title || slug.replace(/-/g, ' '),
      order: Number.isFinite(order) ? order : 100,
    },
    body,
  };
}

/** The release notes, or null if this checkout can produce neither.
 *
 * Generated per request like the doc files, and for the same reason: an entry
 * merged after the server started still shows up. Falling back to the built
 * FEATURES.md covers a deploy that ships the generated file but not `scripts/`.
 */
async function featureNotes(): Promise<string | null> {
  try {
    const mod = await import(pathToFileURL(FEATURES_SCRIPT).href);
    return String(mod.buildFeatures(REPO_ROOT).markdown);
  } catch {
    try {
      return fs.readFileSync(FEATURES_MD, 'utf8');
    } catch {
      return null;
    }
  }
}

/** Whether to advertise "What's New" — cheap enough for the topic list, which
 * must not promise a page that would then 404. */
function hasFeatureNotes(): boolean {
  return fs.existsSync(FEATURES_SCRIPT) || fs.existsSync(FEATURES_MD);
}

/** Every topic, in sidebar order (`order:` front-matter, then slug). */
export function listTopics(): HelpTopicDTO[] {
  let files: string[];
  try {
    files = fs.readdirSync(HELP_DIR);
  } catch {
    return [];
  }
  const topics = files
    .filter((f) => f.endsWith('.md'))
    .map((f) => f.slice(0, -3))
    .filter((slug) => SLUG_RE.test(slug))
    .filter((slug) => slug !== WHATS_NEW.slug) // a file must not shadow the generated page
    .map((slug) => readTopic(slug)?.topic)
    .filter((t): t is HelpTopicDTO => t !== undefined);
  if (hasFeatureNotes()) topics.push(WHATS_NEW);
  return topics.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

/** Raw markdown for one topic — front-matter stripped. 404 if there is no such file. */
export async function getPage(slug: string): Promise<HelpPageDTO> {
  if (!SLUG_RE.test(slug)) throw notFound('no such help page');
  if (slug === WHATS_NEW.slug) {
    const markdown = await featureNotes();
    if (markdown === null) throw notFound('no such help page');
    return { slug, title: WHATS_NEW.title, markdown: markdown.trim() + '\n' };
  }
  const found = readTopic(slug);
  if (!found) throw notFound('no such help page');
  return { slug, title: found.topic.title, markdown: found.body.trim() + '\n' };
}
