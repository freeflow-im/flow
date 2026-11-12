// Prompts (docs/specs/agents.md §1.2): the suggested prompts the assistant's panel offers before the first message, one
// list per page it opens on. Owners and admins change them for the whole organization; a page left as it is keeps the
// suite's defaults (and follows them when they change). Saved together, with one button.
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDTO } from '@flow/shared';
import { DEFAULT_PROMPTS, MAX_PROMPT_LENGTH, MAX_PROMPTS, PROMPT_PAGE_LABELS, PROMPT_PAGES, promptsChanged, type AssistantPrompts, type PromptPage } from '@flow/suite-bar';
import { promptsApi } from '../api';
import { Button, Card, ErrorLine } from '../components/ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** What each page is, in a line: where the panel offers these. */
const PAGE_HELP: Record<PromptPage, string> = {
  home: 'The assistant on the Home page.',
  admin: 'The assistant beside any Admin section.',
  'mail-inbox': 'Mail, with no message open.',
  'mail-message': 'Mail, with a message open.',
  chat: 'Chat has no assistant panel yet; these are kept for when it does.',
  calendar: 'Calendar. Until you change them, an open event offers its own.',
  'docs-list': 'Docs, on the list of files.',
  'docs-file': 'Docs, with a file open. Until you change them, a spreadsheet or presentation offers its own.',
};

type Lists = Record<PromptPage, string[]>;

const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const listsOf = (saved: AssistantPrompts): Lists => Object.fromEntries(PROMPT_PAGES.map((p) => [p, saved[p] ?? DEFAULT_PROMPTS[p]])) as Lists;
/** What is saved: only the pages that differ from the defaults, so the others keep following them. */
const toSave = (lists: Lists): AssistantPrompts =>
  Object.fromEntries(
    PROMPT_PAGES.map((p) => [p, lists[p].map((x) => x.trim()).filter(Boolean)] as const).filter(([p, list]) => !same(list, DEFAULT_PROMPTS[p])),
  );

export function Prompts({ org }: { org: WorkspaceDTO }) {
  const qc = useQueryClient();
  const saved = useQuery({ queryKey: ['prompts', org.id], queryFn: () => promptsApi.get(org.id) });
  const [lists, setLists] = useState<Lists | null>(null);
  useEffect(() => {
    if (saved.data) setLists(listsOf(saved.data));
  }, [saved.data]);
  const save = useMutation({
    mutationFn: (prompts: AssistantPrompts) => promptsApi.save(org.id, prompts),
    onSuccess: (prompts) => {
      qc.setQueryData(['prompts', org.id], prompts);
      // The assistant on this page (Admin's own) shows the new ones at once.
      promptsChanged(org.id, prompts);
    },
  });
  const dirty = useMemo(() => !!lists && !!saved.data && JSON.stringify(toSave(lists)) !== JSON.stringify(toSave(listsOf(saved.data))), [lists, saved.data]);
  const set = (page: PromptPage, list: string[]) => setLists((l) => (l ? { ...l, [page]: list } : l));

  return (
    <>
      <p className="text-sm text-muted">
        The prompts the assistant suggests before the first message, on each page it opens on. They are the same for everyone in {org.name}. A click on one sends it.
      </p>
      {saved.isError && <ErrorLine error={errorText(saved.error)} />}
      {lists && (
        <>
          {PROMPT_PAGES.map((page) => (
            <PageCard key={page} page={page} list={lists[page]} onChange={(l) => set(page, l)} disabled={save.isPending} />
          ))}
          <div className="sticky bottom-0 flex items-center gap-3 border-t border-hairline bg-panel py-3">
            <Button kind="primary" disabled={!dirty || save.isPending} onClick={() => save.mutate(toSave(lists))} testid="prompts-save">
              {save.isPending ? 'Saving…' : 'Save prompts'}
            </Button>
            {dirty && (
              <Button kind="link" disabled={save.isPending} onClick={() => setLists(listsOf(saved.data!))} testid="prompts-discard">
                Discard changes
              </Button>
            )}
            {!dirty && save.isSuccess && <span className="text-xs text-muted">Saved.</span>}
            <ErrorLine error={save.isError ? errorText(save.error) : null} />
          </div>
        </>
      )}
    </>
  );
}

const field = 'min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-sm';
const iconButton = 'rounded px-1.5 py-1 text-xs text-muted hover:bg-hover hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent';

function PageCard({ page, list, onChange, disabled }: { page: PromptPage; list: string[]; onChange(list: string[]): void; disabled: boolean }) {
  const isDefault = same(list.map((x) => x.trim()).filter(Boolean), DEFAULT_PROMPTS[page]);
  const move = (i: number, by: -1 | 1) => {
    const next = [...list];
    [next[i], next[i + by]] = [next[i + by]!, next[i]!];
    onChange(next);
  };
  return (
    <Card title={PROMPT_PAGE_LABELS[page]} intro={PAGE_HELP[page]} testid={`prompts-${page}`}>
      <ol className="flex flex-col gap-2">
        {list.map((text, i) => (
          <li key={i} className="flex items-center gap-1">
            <input
              className={field}
              value={text}
              maxLength={MAX_PROMPT_LENGTH}
              disabled={disabled}
              placeholder="What should the assistant be asked?"
              aria-label={`${PROMPT_PAGE_LABELS[page]} prompt ${i + 1}`}
              onChange={(e) => onChange(list.map((x, j) => (j === i ? e.target.value : x)))}
              data-testid={`prompts-${page}-${i}`}
            />
            <button type="button" className={iconButton} disabled={disabled || i === 0} aria-label="Move up" title="Move up" onClick={() => move(i, -1)}>
              ↑
            </button>
            <button type="button" className={iconButton} disabled={disabled || i === list.length - 1} aria-label="Move down" title="Move down" onClick={() => move(i, 1)}>
              ↓
            </button>
            <button type="button" className={iconButton} disabled={disabled} aria-label="Remove" title="Remove" onClick={() => onChange(list.filter((_, j) => j !== i))} data-testid={`prompts-${page}-remove-${i}`}>
              ✕
            </button>
          </li>
        ))}
        {list.length === 0 && <li className="text-xs text-muted">No suggested prompts here: the panel shows only its box to write in.</li>}
      </ol>
      <div className="flex items-center gap-3">
        <Button kind="link" disabled={disabled || list.length >= MAX_PROMPTS} onClick={() => onChange([...list, ''])} testid={`prompts-${page}-add`}>
          + Add a prompt
        </Button>
        {!isDefault && (
          <Button kind="link" disabled={disabled} onClick={() => onChange([...DEFAULT_PROMPTS[page]])} testid={`prompts-${page}-reset`}>
            Reset to defaults
          </Button>
        )}
        {list.length >= MAX_PROMPTS && <span className="text-xs text-muted">{MAX_PROMPTS} at most.</span>}
      </div>
    </Card>
  );
}
