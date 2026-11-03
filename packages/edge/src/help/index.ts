// Built-in help docs (#383), as packages/server/src/services/help.ts serves them: the markdown of docs/help, raw, and
// "What's New" (#474) from the `## Feature` sections of changelog/. The Worker has no files to read, so
// scripts/help.mjs bundles both when it is built (bundle.generated.ts); the rules for reading them are the server's.
import type { HelpPageDTO, HelpTopicDTO } from '@flow/shared';
import { notFound } from '../errors';
import { FEATURES_MARKDOWN, HELP_FILES } from './bundle.generated';

export interface HelpBundle { files: Record<string, string>; features: string | null }
const BUNDLE: HelpBundle = { files: HELP_FILES, features: FEATURES_MARKDOWN };

/** The generated topic. Ordered after the written pages, which teach the app. */
const WHATS_NEW: HelpTopicDTO = { slug: 'whats-new', title: "What's New", order: 90 };

/** A slug is a file name, so it must never be able to escape the help dir. */
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Minimal front-matter: a leading `---` block of `key: value` lines. Only `title` and `order` are read. */
export function parseFrontMatter(source: string): { meta: Record<string, string>; body: string } {
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

function readTopic(bundle: HelpBundle, slug: string): { topic: HelpTopicDTO; body: string } | null {
  if (!Object.hasOwn(bundle.files, slug)) return null;
  const { meta, body } = parseFrontMatter(bundle.files[slug]!);
  const order = Number.parseInt(meta.order ?? '', 10);
  return {
    topic: { slug, title: meta.title || slug.replace(/-/g, ' '), order: Number.isFinite(order) ? order : 100 },
    body,
  };
}

/** Every topic, in sidebar order (`order:` front-matter, then slug). */
export function listTopics(bundle: HelpBundle = BUNDLE): HelpTopicDTO[] {
  const topics = Object.keys(bundle.files)
    .filter((slug) => SLUG_RE.test(slug))
    .filter((slug) => slug !== WHATS_NEW.slug) // a file must not shadow the generated page
    .map((slug) => readTopic(bundle, slug)?.topic)
    .filter((t): t is HelpTopicDTO => t !== undefined);
  if (bundle.features !== null) topics.push(WHATS_NEW);
  return topics.sort((a, b) => a.order - b.order || a.slug.localeCompare(b.slug));
}

/** Raw markdown for one topic, front-matter stripped. 404 if there is no such page. */
export function getPage(slug: string, bundle: HelpBundle = BUNDLE): HelpPageDTO {
  if (!SLUG_RE.test(slug)) throw notFound('no such help page');
  if (slug === WHATS_NEW.slug) {
    if (bundle.features === null) throw notFound('no such help page');
    return { slug, title: WHATS_NEW.title, markdown: bundle.features.trim() + '\n' };
  }
  const found = readTopic(bundle, slug);
  if (!found) throw notFound('no such help page');
  return { slug, title: found.topic.title, markdown: found.body.trim() + '\n' };
}
