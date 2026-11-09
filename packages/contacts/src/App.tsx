// FreeFlow Contacts: the suite bar, a search box, the merged list grouped by source on the left, the open contact's card on
// the right with its addresses as chips (a member's opens a DM in Chat, any other is copied), add, edit and delete for the
// person's own contacts, and the switch that shares them with the organization.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, MessageSquare, Plus, Trash2, UserRound } from 'lucide-react';
import { intent } from '@flow/suite-bar';
import { contactsApi, ContactsApiError, setContactsWorkspace, type ContactFields } from './api';
import { ContactsSuiteBar } from './components/ContactsSuiteBar';
import { GuestsChatOnly, NoOrganization } from './components/NoOrganization';
import { useOrganizations } from './hooks/organization';
import { chipAction, groupContacts, type Contact } from './lib/contacts';

const blank: ContactFields = { name: '', emails: [], phone: '', orgName: '', notes: '' };
const fieldsOf = (c: Contact): ContactFields => ({ name: c.name, emails: c.emails, phone: c.phone ?? '', orgName: c.orgName ?? '', notes: c.notes ?? '' });
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App() {
  const qc = useQueryClient();
  const organizations = useOrganizations();
  const org = organizations.active?.id ?? null;
  setContactsWorkspace(org);
  const shownOrg = useRef(org);
  useEffect(() => {
    if (shownOrg.current === org) return;
    shownOrg.current = org;
    void qc.resetQueries({ queryKey: ['contacts'] });
  }, [org, qc]);

  const list = useQuery({ queryKey: ['contacts', 'list', org], queryFn: contactsApi.list, enabled: !!org });
  const shared = useQuery({ queryKey: ['contacts', 'shared', org], queryFn: contactsApi.shared, enabled: !!org });
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(() => new URLSearchParams(window.location.search).get('contact'));
  const [editing, setEditing] = useState<{ id: string | null; fields: ContactFields } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const contacts = list.data ?? [];
  const groups = useMemo(() => groupContacts(contacts, q), [contacts, q]);
  const open = contacts.find((c) => c.id === openId) ?? null;

  const refresh = () => qc.invalidateQueries({ queryKey: ['contacts'] });
  const save = useMutation({
    mutationFn: (e: { id: string | null; fields: ContactFields }) => (e.id ? contactsApi.update(e.id, e.fields) : contactsApi.add(e.fields)),
    onSuccess: (c) => { setEditing(null); setOpenId(c.id); void refresh(); },
    onError: (e) => setNotice(errorText(e)),
  });
  const remove = useMutation({ mutationFn: contactsApi.remove, onSuccess: () => { setOpenId(null); void refresh(); }, onError: (e) => setNotice(errorText(e)) });
  const share = useMutation({ mutationFn: contactsApi.share, onSuccess: () => void refresh(), onError: (e) => setNotice(errorText(e)) });

  async function onChip(address: string) {
    const action = chipAction(address, contacts);
    if (action.kind === 'copy') {
      await navigator.clipboard?.writeText(action.address).catch(() => {});
      setNotice(`Copied ${action.address}`);
      return;
    }
    try {
      intent.create('chat-message', { channel: await contactsApi.dm(org!, action.userId) });
    } catch (e) {
      setNotice(errorText(e));
    }
  }

  const search = { value: q, onChange: setQ, onSubmit: setQ, placeholder: 'Search contacts' };
  // A guest's request is refused (403 guest): guests use Chat only (docs/specs/workspace-admin.md §6.5).
  const guest = list.error instanceof ContactsApiError && list.error.code === 'guest';
  return (
    <div className="flex h-full flex-col">
      <ContactsSuiteBar search={search} guest={guest} />
      {guest ? (
        <GuestsChatOnly />
      ) : organizations.ready && !org ? (
        <NoOrganization />
      ) : (
        <div className="flex min-h-0 flex-1">
          <aside className="flex w-80 shrink-0 flex-col border-r border-hairline bg-panel">
            <div className="flex items-center gap-2 p-3">
              <input className="min-w-0 flex-1 rounded-md border border-border bg-white px-2 py-1 text-sm" placeholder="Search contacts" value={q} onChange={(e) => setQ(e.target.value)} data-testid="contacts-search" />
              <button className="rounded-md p-1.5 text-primary hover:bg-hover" title="Add a contact" onClick={() => setEditing({ id: null, fields: blank })}>
                <Plus className="size-5" />
              </button>
            </div>
            <label className="flex items-center gap-2 px-3 pb-3 text-xs text-muted">
              <input type="checkbox" checked={!!shared.data} disabled={!shared.isSuccess || share.isPending} onChange={(e) => share.mutate(e.target.checked)} data-testid="share-toggle" />
              Share my contacts with the organization
            </label>
            <div className="min-h-0 flex-1 overflow-y-auto">
              {list.isError && <p className="p-3 text-sm text-danger">{errorText(list.error)}</p>}
              {list.isSuccess && groups.length === 0 && <p className="p-3 text-sm text-muted">{q ? 'No one matches.' : 'No contacts yet.'}</p>}
              {groups.map((g) => (
                <section key={g.source}>
                  <h2 className="px-3 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide text-faint">{g.label}</h2>
                  {g.contacts.map((c) => (
                    <button key={c.id} onClick={() => { setOpenId(c.id); setEditing(null); }} className={`block w-full px-3 py-1.5 text-left text-sm hover:bg-hover ${c.id === openId ? 'bg-selected-blue' : ''}`}>
                      <span className="block truncate">{c.name}</span>
                      <span className="block truncate text-xs text-muted">{c.owner ? `${c.owner.name}’s · ` : ''}{c.emails[0] ?? c.orgName ?? ''}</span>
                    </button>
                  ))}
                </section>
              ))}
            </div>
          </aside>
          <main className="min-w-0 flex-1 overflow-y-auto p-6">
            {notice && (
              <p className="mb-4 rounded-md bg-warn-bg px-3 py-2 text-sm" onClick={() => setNotice(null)}>
                {notice}
              </p>
            )}
            {editing ? (
              <ContactForm initial={editing.fields} busy={save.isPending} onCancel={() => setEditing(null)} onSave={(fields) => save.mutate({ id: editing.id, fields })} />
            ) : open ? (
              <div className="max-w-lg">
                <div className="mb-4 flex items-center gap-3">
                  <UserRound className="size-10 text-faint" strokeWidth={1.5} />
                  <div className="min-w-0 flex-1">
                    <h1 className="truncate text-lg font-semibold">{open.name}</h1>
                    <p className="text-xs text-muted">{open.source === 'own' ? 'My contact' : open.source === 'member' ? 'Member of the organization' : open.source === 'shared' ? `Shared by ${open.owner?.name ?? 'a member'}` : 'Someone you wrote to'}</p>
                  </div>
                  {open.source === 'own' && (
                    <>
                      <button className="rounded-md border border-border px-2 py-1 text-sm hover:bg-hover" onClick={() => setEditing({ id: open.id, fields: fieldsOf(open) })}>Edit</button>
                      <button className="rounded-md p-1.5 text-danger hover:bg-hover" title="Delete" onClick={() => window.confirm(`Delete ${open.name}?`) && remove.mutate(open.id)}>
                        <Trash2 className="size-4" />
                      </button>
                    </>
                  )}
                </div>
                <div className="mb-4 flex flex-wrap gap-2">
                  {open.emails.map((e) => {
                    const dm = chipAction(e, contacts).kind === 'dm';
                    return (
                      <button key={e} onClick={() => void onChip(e)} title={dm ? 'Message in Chat' : 'Copy the address'} className="inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1 text-sm hover:bg-hover">
                        {dm ? <MessageSquare className="size-3.5 text-primary" /> : <Copy className="size-3.5 text-muted" />}
                        {e}
                      </button>
                    );
                  })}
                </div>
                <dl className="space-y-2 text-sm">
                  {open.phone && <div><dt className="text-xs text-muted">Phone</dt><dd>{open.phone}</dd></div>}
                  {open.orgName && <div><dt className="text-xs text-muted">Organization</dt><dd>{open.orgName}</dd></div>}
                  {open.notes && <div><dt className="text-xs text-muted">Notes</dt><dd className="whitespace-pre-wrap">{open.notes}</dd></div>}
                </dl>
              </div>
            ) : (
              <p className="text-sm text-muted">Choose someone on the left, or add a contact.</p>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

function ContactForm({ initial, busy, onSave, onCancel }: { initial: ContactFields; busy: boolean; onSave(f: ContactFields): void; onCancel(): void }) {
  const [f, setF] = useState({ ...initial, emails: initial.emails.join(', ') });
  const input = (key: 'name' | 'emails' | 'phone' | 'orgName', label: string) => (
    <label className="block text-sm">
      <span className="text-xs text-muted">{label}</span>
      <input className="mt-0.5 w-full rounded-md border border-border px-2 py-1" value={f[key]} onChange={(e) => setF({ ...f, [key]: e.target.value })} />
    </label>
  );
  return (
    <form className="max-w-lg space-y-3" onSubmit={(e) => { e.preventDefault(); onSave({ ...f, emails: f.emails.split(/[\s,;]+/).filter(Boolean) }); }}>
      {input('name', 'Name')}
      {input('emails', 'Email addresses (separated by commas)')}
      {input('phone', 'Phone')}
      {input('orgName', 'Organization')}
      <label className="block text-sm">
        <span className="text-xs text-muted">Notes</span>
        <textarea className="mt-0.5 w-full rounded-md border border-border px-2 py-1" rows={3} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={busy || !f.name.trim()} className="rounded-md bg-primary px-3 py-1 text-sm font-semibold text-white disabled:opacity-50">Save</button>
        <button type="button" onClick={onCancel} className="rounded-md border border-border px-3 py-1 text-sm">Cancel</button>
      </div>
    </form>
  );
}
