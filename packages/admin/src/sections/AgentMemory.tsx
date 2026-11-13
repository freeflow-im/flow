// What an agent remembers (docs/specs/agents.md §6.1): its memory files, as the person may see them, to read, correct,
// delete, or forget all at once. A personal agent's are its sponsor's alone; a shared agent's team folder is its sponsor's
// and the admins', and each person sees their own `you` folder.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { WorkspaceDTO } from '@flow/shared';
import { adminApi, type MemoryFileDTO } from '../api';
import { Button, Confirm, ErrorLine } from '../components/ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** The Memory link of an agent's row, and the files under it once opened. */
export function AgentMemory({ org, userId, name }: { org: WorkspaceDTO; userId: string; name: string }) {
  const [open, setOpen] = useState(false);
  if (!open) {
    return (
      <Button kind="link" onClick={() => setOpen(true)} testid={`agent-memory-${name}`}>
        Memory
      </Button>
    );
  }
  return <MemoryFiles org={org} userId={userId} name={name} onClose={() => setOpen(false)} />;
}

function MemoryFiles({ org, userId, name, onClose }: { org: WorkspaceDTO; userId: string; name: string; onClose(): void }) {
  const qc = useQueryClient();
  const key = ['agent-memory', org.id, userId];
  const memory = useQuery({ queryKey: key, queryFn: () => adminApi.agentMemory(org.id, userId) });
  const refresh = () => void qc.invalidateQueries({ queryKey: key });
  const [forgetting, setForgetting] = useState(false);
  const forget = useMutation({ mutationFn: () => adminApi.forgetAgentMemory(org.id, userId), onSuccess: () => { setForgetting(false); refresh(); } });
  const files = memory.data?.files ?? [];
  return (
    <div className="flex w-full flex-col gap-2 rounded-lg bg-panel p-3" data-testid={`agent-memory-files-${name}`}>
      <div className="flex items-center gap-2">
        <span className="text-sm font-medium">What {name} remembers</span>
        <span className="flex-1" />
        <Button kind="link" onClick={onClose}>Close</Button>
      </div>
      {memory.isError && <ErrorLine error={errorText(memory.error)} />}
      {memory.isSuccess && !files.length && <p className="text-xs text-muted" data-testid={`agent-memory-empty-${name}`}>Nothing yet. {name} saves what will help later (your preferences, facts about people and projects) as you work with it.</p>}
      {memory.data?.shared && <p className="text-xs text-muted">Files in team/ are used for everyone who asks {name}{memory.data.mayEditTeam ? '' : ' (only its sponsor and admins see them here)'}; files in you/ are yours alone.</p>}
      {files.map((f) => <MemoryFile key={f.path} org={org} userId={userId} file={f} onDone={refresh} />)}
      {files.length > 0 &&
        (forgetting ? (
          <Confirm question={`Forget everything ${name} remembers here? This cannot be undone.`} busy={forget.isPending} onYes={() => forget.mutate()} onNo={() => setForgetting(false)} testid={`agent-memory-forget-confirm-${name}`} />
        ) : (
          <div>
            <Button kind="link" onClick={() => setForgetting(true)} testid={`agent-memory-forget-${name}`}>Forget everything</Button>
          </div>
        ))}
      <ErrorLine error={forget.isError ? errorText(forget.error) : null} />
    </div>
  );
}

function MemoryFile({ org, userId, file, onDone }: { org: WorkspaceDTO; userId: string; file: MemoryFileDTO; onDone(): void }) {
  const [text, setText] = useState<string | null>(null);
  const save = useMutation({ mutationFn: (body: string) => adminApi.saveAgentMemory(org.id, userId, { path: file.path, body }), onSuccess: () => { setText(null); onDone(); } });
  const remove = useMutation({ mutationFn: () => adminApi.forgetAgentMemory(org.id, userId, file.path), onSuccess: onDone });
  const id = file.path.replace(/^\/memories\//, '');
  return (
    <div className="flex flex-col gap-1 rounded-md border border-hairline bg-white p-2" data-testid={`memory-file-${id}`}>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <code className="font-mono">{id}</code>
        {file.trust === 'external' && <span className="rounded bg-hover px-1.5 py-0.5 text-muted" title="Written while reading someone else's content (mail, a message, a document)">from someone else's content</span>}
        <span className="flex-1" />
        <span className="text-muted">{new Date(file.updatedAt).toLocaleString()}</span>
      </div>
      <textarea className="rounded-md border border-hairline px-2 py-1 font-mono text-xs text-ink" rows={Math.min(8, Math.max(2, (text ?? file.body).split('\n').length))} maxLength={4000} value={text ?? file.body} onChange={(e) => setText(e.target.value)} data-testid={`memory-file-text-${id}`} />
      <div className="flex gap-3">
        <Button kind="primary" disabled={save.isPending || text === null || text === file.body} onClick={() => text !== null && save.mutate(text)} testid={`memory-file-save-${id}`}>Save</Button>
        <Button kind="link" disabled={remove.isPending} onClick={() => remove.mutate()} testid={`memory-file-delete-${id}`}>Delete</Button>
      </div>
      <ErrorLine error={save.isError ? errorText(save.error) : remove.isError ? errorText(remove.error) : null} />
    </div>
  );
}
