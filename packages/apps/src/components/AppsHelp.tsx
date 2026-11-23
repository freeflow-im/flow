// "Understanding apps" on the apps home: a callout that opens a popup explaining custom apps — how they run, the
// builder, their storage and the caller's identity, the tools and events they publish, and the `ctx` they receive.
// The ctx list follows the SDK (packages/edge/src/apps/sdk.ts) and the builder's guide; keep them in step.
import { useEffect, useState, type ReactNode } from 'react';
import { BookOpen, X } from 'lucide-react';

/** The callout, with its popup. */
export function AppsHelpCallout() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-full items-start gap-3 rounded-xl border border-primary/20 bg-primary/5 p-4 text-left hover:bg-primary/10"
        data-testid="apps-help"
      >
        <BookOpen className="mt-0.5 size-5 shrink-0 text-primary" />
        <span>
          <span className="block text-sm font-semibold text-ink">Understanding apps</span>
          <span className="block text-xs text-muted">How custom apps work, what they can store and do, the tools and events they publish, and the ctx API their code gets.</span>
        </span>
      </button>
      {open && <AppsHelpDialog onClose={() => setOpen(false)} />}
    </>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-sm font-semibold text-ink">{title}</h3>
      {children}
    </section>
  );
}

const CTX: [string, string, string?][] = [
  ['ctx.caller', 'Who is calling the tool or viewing the screen: { accountId, userId, displayName, kind, scopes }. Signed by FreeFlow, so the app cannot be lied to about it.'],
  ['ctx.db', 'The app’s own SQLite database: all(sql, …params), one(…), run(…), batch([{ sql, params }]) in one transaction. Tables come from migrations/NNNN_name.sql.'],
  ['ctx.files', 'The app’s own file storage: put(key, data, { type }), get(key), delete(key), list(prefix), response(key); copyFromChat(fileId, key?) copies a Chat file in.'],
  ['ctx.publish', 'publish(type, data, { ref: { kind, id }, about: [accountId] }): one of the events the manifest declares.'],
  ['ctx.members', 'list() and search(text): the organization’s people and agents as the caller sees them.', 'members:read'],
  ['ctx.chat', 'post(channelId, text) as the caller; file(fileId) reads a Chat file’s facts.', 'chat:write, files:read'],
  ['ctx.docs', 'read(path): a Docs page, as the caller.', 'docs:read'],
  ['ctx.oauth', 'fetch(id, url), token(id), status(id), disconnect(id): the caller’s own account on another service they signed in to. FreeFlow runs the sign-in and keeps the secret.', 'the manifest’s "oauth"'],
];

const Code = ({ children }: { children: ReactNode }) => <code className="rounded bg-panel px-1 py-0.5 font-mono text-[11px] text-ink">{children}</code>;

/** The popup itself. Escape or the backdrop closes it. */
export function AppsHelpDialog({ onClose }: { onClose(): void }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="dialog" aria-modal="true" aria-label="Understanding apps" data-testid="apps-help-dialog" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white text-sm shadow-xl">
        <div className="flex items-center gap-2 border-b border-hairline px-5 py-3">
          <BookOpen className="size-5 text-primary" />
          <h2 className="text-base font-semibold">Understanding apps</h2>
          <button type="button" className="ml-auto text-muted hover:text-ink" onClick={onClose} aria-label="Close"><X className="size-4" /></button>
        </div>
        <div className="flex flex-col gap-5 overflow-y-auto px-5 py-4 text-xs leading-relaxed text-ink">
          <Section title="How apps work">
            <p>Apps let you extend FreeFlow with new custom experiences. Apps are implemented in HTML and JavaScript, and can have a backend with persistent storage. Apps are hosted and executed inside of the FreeFlow system — you don’t host them yourself.</p>
            <p>An app is a few files: <Code>freeflow-app.json</Code> (its name, scopes, tools and events), <Code>server.js</Code> (the code behind the tools and the screen’s routes), <Code>migrations/</Code> (its database tables) and <Code>ui/</Code> (its screen, served from the app’s own origin in a sandboxed frame).</p>
          </Section>
          <Section title="Build one with the app builder">
            <p>Under <strong>Build an app</strong>, give it a name and you get a small working app to start from. Edit the files yourself or ask the assistant beside the builder (“add a due date”) — it writes the changes and the live preview updates. Try runs a tool, Publish makes a version.</p>
            <p>A draft runs only for you. Once published, an owner or admin installs it and chooses who gets it; agents can build apps too, with the same steps.</p>
          </Section>
          <Section title="Storage and identity">
            <p>Each app has its own persistent storage: a SQLite database and a file store, kept per organization and across versions.</p>
            <p>Every tool call and screen request says who is asking — the person or agent, with the scopes they hold. The app decides what that caller may see and change, and when it reads Docs, Chat or members it acts <em>as the caller</em>, never with more than they can reach. It reaches the internet only through the hosts its manifest lists.</p>
          </Section>
          <Section title="Tools and events">
            <p><strong>Tools</strong> are what agents call, named <Code>app__tool</Code> (e.g. <Code>tasks__list_tasks</Code>). Each has a description agents read as guidance, an input schema, and the scopes a caller needs. Installing an app gives its tools to the agents with access.</p>
            <p><strong>Events</strong> are what the app announces, like <Code>task.assigned</Code>. It declares them in the manifest and publishes them with <Code>ctx.publish</Code>; people and agents holding the app’s read scope see them, and naming an account in <Code>about</Code> can wake that agent.</p>
          </Section>
          <Section title="The ctx API">
            <p>Every tool handler and route in <Code>server.js</Code> receives <Code>ctx</Code>:</p>
            <pre className="overflow-x-auto rounded-md bg-panel p-3 font-mono text-[11px]">{`tools: {
  list_tasks: async (input, ctx) =>
    ctx.db.all('SELECT * FROM tasks WHERE owner = ?', ctx.caller.accountId),
}`}</pre>
            <dl className="flex flex-col gap-2" data-testid="apps-help-ctx">
              {CTX.map(([name, what, uses]) => (
                <div key={name}>
                  <dt className="font-mono text-[11px] font-semibold">{name}{uses && <span className="ml-2 font-sans font-normal text-muted">needs “{uses}” in uses</span>}</dt>
                  <dd className="text-muted">{what}</dd>
                </div>
              ))}
            </dl>
            <p>Throw an error to refuse; its message goes back to the caller as it is.</p>
          </Section>
        </div>
      </div>
    </div>
  );
}
