// Web and image search on the assistant's own model provider, for when there is no Brave Search API key (the
// user's in Settings, or the server's BRAVE_SEARCH_API_KEY). Each search is a short request of its own with the
// provider's built-in web search (Claude's web_search and web_fetch, OpenAI's web_search), so the conversation and
// its stored history never hold provider-specific search blocks. Image results are only candidates: the caller
// checks that each loads as a picture (tools.ts), as it does Brave's.
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import type { ModelChoice } from './settings.ts';

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
}

export interface ImageCandidate {
  title: string;
  image_url: string;
  source_page_url: string | null;
}

export interface ProviderSearch {
  /** The provider's name, for messages to the model. */
  readonly name: string;
  web(query: string, max: number): Promise<WebResult[]>;
  images(query: string, max: number): Promise<ImageCandidate[]>;
}

/** Claude model the searches run on: web_search_20260209 needs a Sonnet or Opus, and search needs no more than Sonnet. */
const CLAUDE_SEARCH_MODEL = 'claude-sonnet-5-5';
const TIMEOUT_MS = 90_000;

/**
 * Search on the user's own key (`choice`), or on the server's Anthropic key (null, a server with a model of its
 * own). OpenRouter has none here: null.
 */
export function providerSearch(choice: ModelChoice | null): ProviderSearch | null {
  if (!choice) return claudeSearch(() => new Anthropic({ timeout: TIMEOUT_MS, maxRetries: 1 }));
  if (choice.provider === 'anthropic') return claudeSearch(() => new Anthropic({ apiKey: choice.apiKey, timeout: TIMEOUT_MS, maxRetries: 1 }));
  if (choice.provider === 'openai') return openaiSearch(() => new OpenAI({ apiKey: choice.apiKey, timeout: TIMEOUT_MS, maxRetries: 1 }), choice.model);
  return null;
}

const webPrompt = (query: string, max: number) => `Search the web for: ${query}\n\nThen list the ${max} most relevant results in one short line each.`;

const imagePrompt = (query: string, max: number) =>
  [
    `Find pictures on the web of: ${query}`,
    '',
    'Search the web, and open pages when you need to, to find the direct addresses of the image files themselves: addresses ending in .png, .jpg, .jpeg, .gif or .webp, not web pages and not SVG files. Prefer upload.wikimedia.org (Wikimedia Commons and Wikipedia) and official sources such as a company’s press or brand pages.',
    '',
    `Answer with only a JSON array of up to ${max * 2} objects, best first, each {"title": "...", "image_url": "...", "source_page_url": "..."}, and nothing else. Answer [] if you found none.`,
  ].join('\n');

function claudeSearch(client: () => Anthropic): ProviderSearch {
  const ask = (prompt: string, tools: Anthropic.ToolUnion[]) =>
    client().messages.create({ model: CLAUDE_SEARCH_MODEL, max_tokens: 8000, output_config: { effort: 'low' }, tools, messages: [{ role: 'user', content: prompt }] });
  return {
    name: 'Anthropic',
    async web(query, max) {
      const res = await ask(webPrompt(query, max), [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2 }]);
      // What a result says comes from the answer's citations of it; the results themselves carry no readable text.
      const cited = new Map<string, string>();
      for (const b of res.content) {
        if (b.type !== 'text') continue;
        for (const c of b.citations ?? []) if (c.type === 'web_search_result_location' && !cited.has(c.url)) cited.set(c.url, c.cited_text);
      }
      const out: WebResult[] = [];
      for (const b of res.content) {
        if (b.type !== 'web_search_tool_result' || !Array.isArray(b.content)) continue;
        for (const r of b.content) out.push({ title: r.title, url: r.url, snippet: cited.get(r.url) ?? '' });
      }
      return out;
    },
    async images(query, max) {
      const res = await ask(imagePrompt(query, max), [
        { type: 'web_search_20260209', name: 'web_search', max_uses: 3 },
        { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 3 },
      ]);
      return imageCandidates(res.content.map((b) => (b.type === 'text' ? b.text : '')).join(''));
    },
  };
}

function openaiSearch(client: () => OpenAI, model: string): ProviderSearch {
  const ask = (prompt: string) => client().responses.create({ model, input: prompt, tools: [{ type: 'web_search' }], reasoning: { effort: 'low' }, store: false });
  return {
    name: 'OpenAI',
    async web(query, max) {
      const res = await ask(webPrompt(query, max));
      // The results are the answer's citations, each with the words of the answer that cite it.
      const out: WebResult[] = [];
      for (const item of res.output) {
        if (item.type !== 'message') continue;
        for (const part of item.content) {
          if (part.type !== 'output_text') continue;
          for (const a of part.annotations) {
            if (a.type === 'url_citation') out.push({ title: a.title, url: a.url, snippet: part.text.slice(a.start_index, a.end_index) });
          }
        }
      }
      return out;
    },
    async images(query, max) {
      return imageCandidates((await ask(imagePrompt(query, max))).output_text);
    },
  };
}

/** The candidates in the model's answer: the JSON array in it, leniently (the answer may have words around it). */
export function imageCandidates(text: string): ImageCandidate[] {
  const start = text.indexOf('[');
  const end = text.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: ImageCandidate[] = [];
  for (const v of parsed) {
    if (!v || typeof v !== 'object') continue;
    const { title, image_url, source_page_url } = v as Record<string, unknown>;
    if (typeof image_url !== 'string') continue;
    out.push({ title: typeof title === 'string' ? title : '', image_url, source_page_url: typeof source_page_url === 'string' ? source_page_url : null });
  }
  return out;
}
