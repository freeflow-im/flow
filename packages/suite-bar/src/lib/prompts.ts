// The assistant's suggested prompts, by page (docs/specs/agents.md §1.2): what the organization set in Admin → Prompts,
// else the app's own defaults. One read per organization, shared by every panel on the page and kept for the page's
// life; Admin sends PROMPTS_CHANGED after a save, so a panel on the same page shows the new ones at once.
import { useEffect, useState } from 'react';
import { cleanPrompts, DEFAULT_PROMPTS, type AssistantPrompts, type PromptPage } from '@flow/shared/assistant';

export { DEFAULT_PROMPTS, MAX_PROMPTS, MAX_PROMPT_LENGTH, PROMPT_PAGES, PROMPT_PAGE_LABELS, cleanPrompts, type AssistantPrompts, type PromptPage } from '@flow/shared/assistant';

/** The window event after the organization's prompts changed here (Admin's save). */
export const PROMPTS_CHANGED = 'flow:assistant-prompts-changed';

const reads = new Map<string, Promise<AssistantPrompts>>();

export const promptsAddress = (organizationId: string) => `/v1/workspaces/${encodeURIComponent(organizationId)}/assistant-prompts`;

/** The organization's saved prompts, read once (a failed read is not kept, so the next panel asks again). */
export function readPrompts(organizationId: string): Promise<AssistantPrompts> {
  let p = reads.get(organizationId);
  if (!p) {
    p = fetch(promptsAddress(organizationId), { credentials: 'same-origin', headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? (r.json() as Promise<{ prompts?: unknown }>) : Promise.reject(new Error(String(r.status)))))
      .then((body) => cleanPrompts(body.prompts));
    p.catch(() => reads.delete(organizationId));
    reads.set(organizationId, p);
  }
  return p;
}

/** After a save: the next read asks the server, and the panels on this page read again. */
export function promptsChanged(organizationId: string, saved?: AssistantPrompts): void {
  if (saved) reads.set(organizationId, Promise.resolve(saved));
  else reads.delete(organizationId);
  window.dispatchEvent(new Event(PROMPTS_CHANGED));
}

/**
 * The prompts a panel offers on a page. `fallback` is the app's own default for what is open (Docs' for a spreadsheet),
 * shown until the organization's are read and whenever it has not changed this page; else the suite's default.
 */
export function useSuggestedPrompts(organizationId: string | null, page: PromptPage, fallback?: string[]): string[] {
  const [saved, setSaved] = useState<AssistantPrompts | null>(null);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    const again = () => setAsked((n) => n + 1);
    window.addEventListener(PROMPTS_CHANGED, again);
    return () => window.removeEventListener(PROMPTS_CHANGED, again);
  }, []);
  useEffect(() => {
    if (!organizationId) return setSaved(null);
    let live = true;
    readPrompts(organizationId).then(
      (p) => live && setSaved(p),
      () => live && setSaved(null),
    );
    return () => {
      live = false;
    };
  }, [organizationId, asked]);
  return saved?.[page] ?? fallback ?? DEFAULT_PROMPTS[page];
}
