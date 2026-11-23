// The Build app page (docs/specs/user-apps.md §9.6): the apps home at /apps/, with the installed apps, the person's drafts
// and New app; and a draft open at /apps/?build=<name>: its files, the file open in an editor, its live preview (the dev
// install's screen), Try for its tools, Publish, and the suite's assistant panel told the app and the file open, so
// "add a due date" goes to the right files. The page reads the draft again every few seconds, so what the assistant
// writes shows: the file list, the problems, the open file (when it has no unsaved edit) and the preview.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronLeft, FilePlus, Play, RotateCw, Trash2, Upload } from 'lucide-react';
import { SuiteAssistantColumn } from '@flow/suite-bar/assistant-chat';
import { AppIcon, intent } from '@flow/suite-bar';
import { appsApi, type AppDraft, type InstalledApp, type ToolAnswer } from '../api';
import { InstallDialog } from './InstallDialog';
import { AppsHelpCallout } from './AppsHelp';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const POLL_MS = 3000;
const go = (search: string) => window.location.assign(`/apps/${search}`);

/**
 * Opens an installed hosted app in the builder (§9.6): the person's draft of it, made from the installed version when
 * they have none yet. Back comes an error to show, or nothing when the page is on its way.
 */
export async function editApp(org: string, name: string, label: string): Promise<string | null> {
  try {
    await appsApi.createDraft(org, name, label, true);
  } catch (e) {
    if (!/already have a draft/.test(errorText(e))) return errorText(e);
  }
  go(`?build=${name}`);
  return null;
}

/** The apps home: what is installed, what the person is building, and New app. */
export function AppsHome({ org, apps, admin }: { org: string; apps: InstalledApp[]; admin: boolean }) {
  const drafts = useQuery({ queryKey: ['drafts', org], queryFn: () => appsApi.drafts(org) });
  const [name, setName] = useState('');
  const [label, setLabel] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = async (n: string, l: string, fromInstalled = false) => {
    setError(null);
    if (fromInstalled) {
      setError(await editApp(org, n, l));
      return;
    }
    try {
      await appsApi.createDraft(org, n, l);
      go(`?build=${n}`);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const shown = apps.filter((a) => a.usable);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-panel p-6">
      <div className="mx-auto flex max-w-3xl flex-col gap-8">
        <section>
          <h1 className="mb-3 text-lg font-semibold text-ink">Apps</h1>
          <div className="mb-4"><AppsHelpCallout /></div>
          {shown.length === 0 && <p className="text-sm text-muted">No apps are installed for you in this organization yet.</p>}
          <ul className="grid gap-3 sm:grid-cols-2" data-testid="app-list">
            {shown.map((a) => (
              <li key={a.name} className="rounded-xl border border-hairline bg-white p-4">
                <a href={`/apps/${a.name}`} className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink hover:text-primary"><AppIcon icon={a.icon} iconUrl={a.iconUrl} />{a.label}</a>
                {a.description && <p className="mt-1 text-xs text-muted">{a.description}</p>}
                {a.hosted && <button type="button" className="mt-2 text-xs font-semibold text-primary hover:underline" onClick={() => void create(a.name, a.label, true)} data-testid={`edit-${a.name}`}>Edit</button>}
              </li>
            ))}
          </ul>
          {admin && (
            <button type="button" className="mt-3 text-sm text-primary hover:underline" onClick={() => intent.admin('apps')}>Install and manage apps in Organization settings</button>
          )}
        </section>
        <section>
          <h2 className="mb-1 text-base font-semibold text-ink">Build an app</h2>
          <p className="mb-3 text-xs text-muted">Start from a small working app, then change it yourself or ask the assistant. It runs only for you until you publish it and an owner or admin installs it.</p>
          <form className="flex flex-col gap-2 sm:flex-row" onSubmit={(e) => { e.preventDefault(); void create(name.trim(), label.trim() || name.trim()); }}>
            <input className="rounded-md border border-border px-2 py-1 text-sm sm:w-40" placeholder="name (tasks)" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} data-testid="new-app-name" />
            <input className="min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-sm" placeholder="What people see (Tasks)" value={label} onChange={(e) => setLabel(e.target.value)} />
            <button type="submit" className="rounded-md bg-primary px-3 py-1 text-sm font-semibold text-white disabled:opacity-50" disabled={!/^[a-z][a-z0-9]{1,19}$/.test(name.trim())} data-testid="new-app">New app</button>
          </form>
          {error && <p className="mt-2 text-xs text-danger">{error}</p>}
          <ul className="mt-4 flex flex-col gap-2" data-testid="draft-list">
            {(drafts.data ?? []).map((d) => (
              <li key={d.name} className="flex items-center justify-between rounded-lg border border-hairline bg-white px-4 py-2">
                <a href={`/apps/?build=${d.name}`} className="text-sm font-medium text-ink hover:text-primary">{d.label} <span className="text-xs text-muted">({d.name})</span></a>
                <span className={`text-xs ${d.problems.length ? 'text-danger' : 'text-muted'}`}>{d.problems.length ? `${d.problems.length} problem${d.problems.length === 1 ? '' : 's'}` : `edited ${new Date(d.updatedAt).toLocaleString()}`}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}

const WIDTH_KEY = 'ff-builder-assistant-width';
const MIN_WIDTH = 280;
const MAX_WIDTH = 720;

/** The assistant column's width: dragged by its edge, kept in this browser (a convenience: the default when it cannot be). */
function useAssistantWidth(): { width: number; dragging: boolean; startDrag(e: React.PointerEvent): void } {
  const [width, setWidth] = useState(() => {
    try { const w = Number(localStorage.getItem(WIDTH_KEY)); return w >= MIN_WIDTH && w <= MAX_WIDTH ? w : 380; } catch { return 380; }
  });
  const [dragging, setDragging] = useState(false);
  const startDrag = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    setDragging(true);
    let last = startW;
    const move = (ev: PointerEvent) => {
      last = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startW + ev.clientX - startX));
      setWidth(last);
    };
    const up = () => {
      setDragging(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      try { localStorage.setItem(WIDTH_KEY, String(last)); } catch { /* the default next time */ }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  return { width, dragging, startDrag };
}

/** The order the file list shows: the manifest, the server, migrations, then the screen's files. */
function fileOrder(a: string, b: string): number {
  const rank = (p: string) => (p === 'freeflow-app.json' ? 0 : p === 'server.js' ? 1 : p.startsWith('migrations/') ? 2 : 3);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** One draft open: files, editor, preview, try, publish, and the assistant beside it. */
export function Builder({ org, name, admin }: { org: string; name: string; admin: boolean }) {
  const qc = useQueryClient();
  const draft = useQuery({ queryKey: ['draft', org, name], queryFn: () => appsApi.draft(org, name), refetchInterval: POLL_MS });
  const d = draft.data;
  const files = useMemo(() => Object.keys(d?.files ?? {}).sort(fileOrder), [d?.files]);
  const [path, setPath] = useState('server.js');
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  // The app first (its live preview); the code is a click away.
  const [view, setView] = useState<'code' | 'preview' | 'try'>('preview');
  const assistant = useAssistantWidth();
  const [notice, setNotice] = useState<string | null>(null);
  const [noticeLink, setNoticeLink] = useState<{ label: string; href: string } | null>(null);
  // An owner or admin installs a published version from here (§9.6): the version the popup is for.
  const [installing, setInstalling] = useState<number | null>(null);
  const loadedAt = useRef<string | null>(null);
  const dirty = text !== saved;

  // The open file, read again when the draft changed and there is no unsaved edit (the assistant may have written it).
  useEffect(() => {
    if (!d || !files.includes(path)) return;
    if (loadedAt.current === `${path}@${d.updatedAt}` || dirty) return;
    let live = true;
    void appsApi.readFile(org, name, path).then((t) => {
      if (!live) return;
      setText(t);
      setSaved(t);
      loadedAt.current = `${path}@${d.updatedAt}`;
    }, () => undefined);
    return () => { live = false; };
  }, [org, name, path, d?.updatedAt, files, dirty, d]);

  const save = async () => {
    try {
      const next = await appsApi.writeFile(org, name, path, text);
      setSaved(text);
      loadedAt.current = `${path}@${next.updatedAt}`;
      qc.setQueryData(['draft', org, name], next);
    } catch (e) {
      setNotice(errorText(e));
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); void save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const open = (p: string) => {
    if (dirty && !window.confirm(`Discard your changes to ${path}?`)) return;
    loadedAt.current = null;
    setSaved('');
    setText('');
    setPath(p);
    setView('code');
  };
  const newFile = async () => {
    const p = window.prompt('New file: ui/<name>, or migrations/NNNN_name.sql');
    if (!p) return;
    try {
      qc.setQueryData(['draft', org, name], await appsApi.writeFile(org, name, p.trim(), ''));
      open(p.trim());
    } catch (e) {
      setNotice(errorText(e));
    }
  };
  const removeFile = async () => {
    if (!window.confirm(`Delete ${path}?`)) return;
    try {
      qc.setQueryData(['draft', org, name], await appsApi.deleteFile(org, name, path));
      open('server.js');
    } catch (e) {
      setNotice(errorText(e));
    }
  };
  const publish = async () => {
    try {
      const v = await appsApi.publish(org, name);
      if (admin) setInstalling(v.version);
      else setNotice(`Published version ${v.version}. An owner or admin installs it in Organization settings → Apps.`);
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  /** Stops an agent editing this draft: it got it when picked in the assistant panel (§9.6). */
  const removeEditor = async (account: string, who: string) => {
    if (!window.confirm(`${who} will no longer edit ${d?.label ?? name}. Picking ${who} in the panel again lets it edit again.`)) return;
    try {
      qc.setQueryData(['draft', org, name], await appsApi.removeEditor(org, name, account));
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  /** Install… opens the popup for the newest published version that is not the one installed. */
  const openInstall = async () => {
    try {
      const mine = (await appsApi.uploads(org)).filter((u) => u.name === name).sort((a, b) => b.version - a.version);
      const latest = mine[0];
      if (!latest) setNotice('Nothing is published yet: Publish version first.');
      else if (latest.installed) setNotice(`Version ${latest.version} is installed already. Publish a new version to update it.`);
      else setInstalling(latest.version);
    } catch (e) {
      setNotice(errorText(e));
    }
  };

  if (draft.isError) return <div className="flex-1 bg-panel p-6 text-sm text-danger">{errorText(draft.error)}</div>;
  if (!d) return <div className="flex-1 bg-panel" />;
  return (
    <div className="relative flex min-h-0 flex-1 flex-col bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline bg-white px-3 py-2">
        <button type="button" className="flex items-center gap-1 text-sm text-muted hover:text-ink" onClick={() => go('')}><ChevronLeft className="size-4" />Apps</button>
        <span className="text-sm font-semibold text-ink" data-testid="building-name">{d.label}</span>
        <span className="text-xs text-muted">draft of {d.name}</span>
        <span className={`text-xs ${d.problems.length ? 'text-danger' : 'text-muted'}`} data-testid="problem-count">{d.problems.length ? `${d.problems.length} problem${d.problems.length === 1 ? '' : 's'}` : 'no problems'}</span>
        <div className="ml-auto flex gap-1">
          {(['code', 'preview', 'try'] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} className={`rounded-md px-3 py-1 text-sm ${view === v ? 'bg-selected-blue font-semibold text-primary' : 'text-ink hover:bg-hover'}`} data-testid={`view-${v}`}>{v === 'code' ? 'Code' : v === 'preview' ? 'Preview' : 'Try'}</button>
          ))}
          {admin && <button type="button" className="rounded-md border border-border px-3 py-1 text-sm hover:bg-hover" onClick={() => void openInstall()} data-testid="install-latest">Install…</button>}
          <button type="button" className="flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-sm font-semibold text-white disabled:opacity-50" disabled={d.problems.length > 0} onClick={() => void publish()} data-testid="publish"><Upload className="size-4" />Publish version</button>
        </div>
      </div>
      {notice && (
        <div className="border-b border-hairline bg-warn-bg px-3 py-1.5 text-xs" data-testid="build-notice">
          {notice}
          {noticeLink && <a className="ml-2 font-semibold text-primary hover:underline" href={noticeLink.href} data-testid="build-notice-open">{noticeLink.label}</a>}
          <button type="button" className="ml-2 text-primary" onClick={() => { setNotice(null); setNoticeLink(null); }}>Close</button>
        </div>
      )}
      {d.editors.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-hairline bg-white px-3 py-1 text-xs text-muted" data-testid="draft-editors">
          <span>Also edits this draft:</span>
          {d.editors.map((e) => (
            <span key={e.account} className="flex items-center gap-1 text-ink">
              {e.name}
              <button type="button" className="text-primary hover:underline" onClick={() => void removeEditor(e.account, e.name)} data-testid="remove-editor">Remove</button>
            </span>
          ))}
        </div>
      )}
      {d.problems.length > 0 && (
        <ul className="max-h-24 overflow-y-auto border-b border-hairline bg-white px-3 py-1 text-xs text-danger" data-testid="problems">
          {d.problems.map((p) => <li key={p}>{p}</li>)}
        </ul>
      )}
      <div className="flex min-h-0 flex-1">
        {/* The assistant on the left, the main way to build (§9.6); its width is the person's, dragged and kept. */}
        <aside className="flex min-h-0 shrink-0 flex-col border-r border-hairline bg-white" style={{ width: assistant.width }} aria-label="Assistant" data-testid="builder-assistant">
          <SuiteAssistantColumn
            organizationId={org}
            page="home"
            context={{ building: { app: name, label: d.label, file: view === 'code' ? path : undefined } }}
            intro={`Tell me what ${d.label} should do, and I will change its code, try it and show it here. I publish only when you ask.`}
            prompts={[`What does ${d.label} do now?`, 'Add a field to each item, and show it on the screen', 'Make the screen look cleaner', 'Add a tool agents can use to search the items']}
          />
        </aside>
        <div className="w-1 shrink-0 cursor-col-resize bg-hairline hover:bg-primary" role="separator" aria-orientation="vertical" aria-label="Resize the assistant" onPointerDown={assistant.startDrag} data-testid="assistant-resize" />
        <main className={`flex min-h-0 min-w-0 flex-1 flex-col ${assistant.dragging ? 'pointer-events-none select-none' : ''}`}>
          {view === 'code' && (
            <>
              <div className="flex items-center gap-2 border-b border-hairline bg-white px-3 py-1 text-xs">
                <span className="font-mono">{path}</span>
                {dirty && <span className="text-muted">unsaved</span>}
                <button type="button" className="ml-auto rounded-md border border-border px-2 py-0.5 disabled:opacity-50" disabled={!dirty} onClick={() => void save()} data-testid="save">Save</button>
                {path !== 'freeflow-app.json' && path !== 'server.js' && <button type="button" className="text-muted hover:text-danger" onClick={() => void removeFile()} title="Delete this file"><Trash2 className="size-3.5" /></button>}
              </div>
              <textarea className="min-h-0 flex-1 resize-none bg-white p-3 font-mono text-xs leading-5 text-ink outline-none" spellCheck={false} value={text} onChange={(e) => setText(e.target.value)} data-testid="editor" />
            </>
          )}
          {view === 'preview' && <Preview org={org} name={name} updatedAt={d.updatedAt} />}
          {view === 'try' && <Try org={org} name={name} draft={d} />}
        </main>
        {/* The files, on the right, with the code only. */}
        {view === 'code' && (
          <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-l border-hairline bg-white p-2" aria-label="Files" data-testid="files">
            {files.map((f) => (
              <button key={f} type="button" onClick={() => open(f)} className={`truncate rounded px-2 py-1 text-left font-mono text-xs ${f === path ? 'bg-selected-blue text-primary' : 'text-ink hover:bg-hover'}`} title={f}>{f}</button>
            ))}
            <button type="button" onClick={() => void newFile()} className="mt-2 flex items-center gap-1 px-2 py-1 text-xs text-primary"><FilePlus className="size-3.5" />New file</button>
          </nav>
        )}
      </div>
      {installing !== null && <InstallDialog org={org} name={name} version={installing} onClose={() => { setInstalling(null); setNotice(`Published version ${installing}. You can install it later with Install… or in Organization settings → Apps.`); }} onDone={(t, open) => { setInstalling(null); setNotice(t); setNoticeLink(open ?? null); }} />}
    </div>
  );
}

/** The draft's screen in its dev install, loaded again when the draft changes. */
function Preview({ org, name, updatedAt }: { org: string; name: string; updatedAt: string }) {
  const [src, setSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const origin = useRef<string | null>(null);
  useEffect(() => {
    let live = true;
    // The first load opens a session on the preview's host with a door key; later loads reuse that session.
    if (origin.current) setSrc(`${origin.current}/?r=${encodeURIComponent(updatedAt)}-${nonce}`);
    else appsApi.preview(org, name).then((p) => { if (!live) return; origin.current = new URL(p.url).origin; setSrc(p.url); }, (e) => live && setError(errorText(e)));
    return () => { live = false; };
  }, [org, name, updatedAt, nonce]);
  if (error) return <div className="p-6 text-sm text-danger">{error}</div>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center border-b border-hairline bg-white px-3 py-1 text-xs text-muted">
        Your dev install: its own data, only you see it.
        <button type="button" className="ml-auto flex items-center gap-1 hover:text-ink" onClick={() => setNonce((n) => n + 1)}><RotateCw className="size-3.5" />Reload</button>
      </div>
      {src && <iframe key={src} src={src} title={`${name} preview`} className="min-h-0 flex-1 border-0 bg-white" sandbox="allow-scripts allow-forms allow-same-origin allow-popups" data-testid="preview-frame" />}
    </div>
  );
}

/** Runs one of the draft's tools in its dev install, as the person. */
function Try({ org, name, draft }: { org: string; name: string; draft: AppDraft }) {
  const [tools, setTools] = useState<string[]>([]);
  const [tool, setTool] = useState('');
  const [input, setInput] = useState('{}');
  const [answer, setAnswer] = useState<ToolAnswer | null>(null);
  const [running, setRunning] = useState(false);
  useEffect(() => {
    void appsApi.readFile(org, name, 'freeflow-app.json').then((t) => {
      try {
        const names = ((JSON.parse(t) as { tools?: { name: string }[] }).tools ?? []).map((x) => x.name);
        setTools(names);
        setTool((cur) => (names.includes(cur) ? cur : names[0] ?? ''));
      } catch { setTools([]); }
    }, () => undefined);
  }, [org, name, draft.updatedAt]);
  const run = async () => {
    let parsed: Record<string, unknown>;
    try { parsed = JSON.parse(input || '{}') as Record<string, unknown>; } catch { setAnswer({ ok: false, error: 'The input is not JSON.' }); return; }
    setRunning(true);
    try { setAnswer(await appsApi.tryTool(org, name, tool, parsed)); } catch (e) { setAnswer({ ok: false, error: errorText(e) }); } finally { setRunning(false); }
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-white p-4 text-sm">
      <p className="text-xs text-muted">Runs a tool as an agent would call it, in your dev install: its own data, no internet.</p>
      <div className="flex gap-2">
        <select className="rounded-md border border-border px-2 py-1" value={tool} onChange={(e) => setTool(e.target.value)} data-testid="try-tool">
          {tools.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <button type="button" className="flex items-center gap-1 rounded-md bg-primary px-3 py-1 font-semibold text-white disabled:opacity-50" disabled={!tool || running || draft.problems.length > 0} onClick={() => void run()} data-testid="try-run"><Play className="size-4" />Run</button>
      </div>
      <textarea className="h-28 rounded-md border border-border p-2 font-mono text-xs" value={input} onChange={(e) => setInput(e.target.value)} spellCheck={false} data-testid="try-input" />
      {answer && <pre className={`overflow-x-auto rounded-md p-2 text-xs ${answer.ok ? 'bg-panel text-ink' : 'bg-warn-bg text-danger'}`} data-testid="try-answer">{answer.ok ? JSON.stringify(answer.result, null, 2) : answer.error}</pre>}
    </div>
  );
}
