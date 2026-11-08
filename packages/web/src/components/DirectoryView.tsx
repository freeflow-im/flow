// The Directory (#430) — a browsable grid of everyone in the workspace, in the
// same "sentinel channel id" shape as the Activity feed and the Scheduled
// panel. Reached from the sidebar entry under Direct messages and from the
// workspace menu.
//
// The roster endpoint already exists (`useMembers`), so this is a view over
// data the client is holding anyway: no fetch per card, and the grid is
// populated the moment the sidebar has drawn.
import { useEffect, useState } from 'react';
import type { WorkspaceEmailResultDTO, WorkspaceMemberDTO } from '@flow/shared';
import { useAuth, useLive, useSelection } from '../state';
import { useMembers, useWorkspaces } from '../hooks';
import { Avatar } from './Avatar';
import { EmailEveryoneModal, resultToastText } from './EmailEveryoneModal';
import { MobileMenuButton } from './MobileMenuButton';
import { UserCard } from './modals';

/** What a card knows about one member — the roster DTO plus live presence. */
export interface DirectoryRow extends WorkspaceMemberDTO {
  online: boolean;
  isSelf: boolean;
  /** Agents only: the display name of the human who sponsored them. */
  sponsorName: string | null;
}

/**
 * Name search: case-insensitive substring over the display name, plus the
 * email's local part so searching "scottp" finds Scott. Agents and app bots
 * carry synthetic addresses (`agent-<uuid>@agents.flow.local`), so theirs are
 * left out — matching one would only ever be an accident. Humans and agents sort together
 * alphabetically: the Directory answers "who is here", and splitting it by kind
 * would bury an agent you were looking for behind every human.
 *
 * Privacy mode (#489) drops a member from the listing *and* from search — one
 * filter for both, because a member who is hidden from the grid but findable by
 * typing their name would not be hidden at all. They are still on the roster,
 * so mentions, DMs and channel membership are untouched; only this view leaves
 * them out. It leaves them out for everyone, themselves included: the settings
 * toggle is the confirmation that it worked, and a roster count that differed
 * per viewer would be the odd thing to explain.
 */
export function filterMembers(rows: DirectoryRow[], query: string): DirectoryRow[] {
  const q = query.trim().toLowerCase();
  const matches = (m: DirectoryRow) =>
    q === '' ||
    m.displayName.toLowerCase().includes(q) ||
    (!m.isAgent && !m.isBot && m.email.toLowerCase().split('@')[0]!.includes(q));
  return rows
    .filter((m) => !m.privacyMode)
    .filter(matches)
    .slice()
    .sort((a, b) => a.displayName.localeCompare(b.displayName, undefined, { sensitivity: 'base' }));
}

const ROLE_LABEL: Record<string, string> = { owner: 'Owner', admin: 'Admin', member: 'Member' };

/** The presentational half: given rows, draw the grid. Kept prop-driven so it
 * renders in a test without a query client or a socket. */
export function DirectoryGrid({
  rows,
  loading,
  query,
  onQuery,
  onSelect,
  canEmailEveryone = false,
  onEmailEveryone,
}: {
  rows: DirectoryRow[];
  loading: boolean;
  query: string;
  onQuery: (v: string) => void;
  onSelect: (userId: string) => void;
  /** #481: owners and admins only — a plain member never sees the button. */
  canEmailEveryone?: boolean;
  onEmailEveryone?: () => void;
}) {
  const shown = filterMembers(rows, query);
  return (
    <section className="flex min-w-0 flex-1 flex-col bg-base">
      <header className="flex h-[60px] shrink-0 items-center justify-between gap-3 border-b border-hairline px-[22px] max-md:px-3">
        <MobileMenuButton />
        <div className="min-w-0 flex-1">
          <h2 data-testid="directory-header" className="truncate text-[15px] font-bold">
            <span className="text-muted">👥 </span>Directory
          </h2>
          <p className="truncate text-xs text-muted">Everyone in this workspace</p>
        </div>
      </header>

      <div className="flex shrink-0 items-center gap-3 border-b border-hairline3 px-[22px] py-2 max-md:px-3">
        <input
          data-testid="directory-search"
          type="search"
          value={query}
          placeholder="Search people…"
          aria-label="Search people"
          className="w-full max-w-sm rounded-lg border border-hairline2 bg-base px-3 py-1.5 text-sm"
          onChange={(e) => onQuery(e.target.value)}
        />
        <span className="ml-auto shrink-0 text-xs text-faint" data-testid="directory-count">
          {shown.length} {shown.length === 1 ? 'person' : 'people'}
        </span>
        {/* #481: owner/admin only. Sits at the right end of the search row —
            the Directory is the view of "everyone this would go to". */}
        {canEmailEveryone && (
          <button
            data-testid="directory-email-everyone"
            title="Email every member of this workspace"
            className="shrink-0 rounded-lg bg-accent px-3 py-1.5 text-sm font-semibold whitespace-nowrap text-white hover:opacity-90"
            onClick={onEmailEveryone}
          >
            ✉️ Email everyone
          </button>
        )}
      </div>

      <div className="mc-scroll min-h-0 flex-1 overflow-y-auto p-4 max-md:p-2" data-testid="directory-grid">
        {loading && rows.length === 0 ? (
          <p className="py-16 text-center text-sm text-faint" data-testid="directory-loading">
            Loading…
          </p>
        ) : shown.length === 0 ? (
          <p className="py-16 text-center text-sm text-faint" data-testid="directory-empty">
            {query.trim() === '' ? 'Nobody is here yet.' : `No one matches “${query.trim()}”.`}
          </p>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
            {shown.map((m) => (
              <DirectoryCard key={m.userId} member={m} onSelect={() => onSelect(m.userId)} />
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function DirectoryCard({ member: m, onSelect }: { member: DirectoryRow; onSelect: () => void }) {
  return (
    <button
      data-testid={`directory-card-${m.displayName}`}
      title={`Open ${m.displayName}’s profile`}
      className="flex w-full items-start gap-3 rounded-xl border border-hairline2 bg-white p-3 text-left hover:border-accent/50 hover:shadow-sm"
      onClick={onSelect}
    >
      <div className="relative shrink-0">
        <Avatar userId={m.userId} name={m.displayName} avatarUrl={m.avatarUrl} size={44} radius={12} />
        <span
          className={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-white ${
            m.online ? 'bg-online' : 'bg-hairline2'
          }`}
          title={m.online ? 'Online' : 'Offline'}
        />
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-bold">
          {m.displayName}
          {m.isSelf && <span className="ml-1 font-normal text-faint">(you)</span>}
          {m.isAgent && <span title="AI agent"> 🤖</span>}
        </p>
        {/* platform.md §3.2: the member's address in this organization, when the server knows it. */}
        {m.address && (
          <p data-testid="directory-card-address" className="truncate text-xs text-muted" title={m.address}>
            {m.address}
          </p>
        )}
        {/* #434: the member's own one-line title, above the role. Omitted
            entirely when unset — no placeholder, no reserved blank line. */}
        {m.title && (
          <p data-testid="directory-card-title" className="truncate text-xs text-ink-soft" title={m.title}>
            {m.title}
          </p>
        )}
        <p className="truncate text-xs text-muted">
          {m.isAgent ? 'AI agent' : m.isBot ? 'App' : ROLE_LABEL[m.role] ?? m.role}
        </p>
        {(m.statusEmoji || m.statusText) && (
          <p className="mt-1 truncate text-xs text-ink-soft" title={m.statusText}>
            {m.statusEmoji && <span>{m.statusEmoji} </span>}
            {m.statusText}
          </p>
        )}
        {/* An agent's email is a synthetic address nobody can write to, so the
            card names its sponsor instead — the useful fact about an agent. */}
        <p className="mt-1 truncate text-xs text-faint">
          {m.isAgent ? (m.sponsorName ? `Sponsored by ${m.sponsorName}` : '') : m.isBot ? '' : m.email}
        </p>
      </div>
    </button>
  );
}

export default function DirectoryView() {
  const sel = useSelection();
  const auth = useAuth();
  const live = useLive();
  const members = useMembers(sel.workspaceId);
  const workspaces = useWorkspaces();
  const [query, setQuery] = useState('');
  const [cardUserId, setCardUserId] = useState<string | null>(null);
  const [emailOpen, setEmailOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Same inline role check the Sidebar uses (Sidebar.tsx:250) — the server
  // enforces it again on every one of the three email routes.
  const ws = (workspaces.data ?? []).find((w) => w.id === sel.workspaceId);
  const isAdmin = ws?.role === 'owner' || ws?.role === 'admin';

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const byId = new Map((members.data ?? []).map((m) => [m.userId, m]));
  const rows: DirectoryRow[] = (members.data ?? []).map((m) => ({
    ...m,
    online: live.isOnline(m.userId),
    isSelf: m.userId === auth.user.id,
    sponsorName: m.sponsorId ? byId.get(m.sponsorId)?.displayName ?? null : null,
  }));

  const onSent = (res: WorkspaceEmailResultDTO) => setToast(resultToastText(res));

  return (
    <>
      <DirectoryGrid
        rows={rows}
        loading={members.isLoading}
        query={query}
        onQuery={setQuery}
        onSelect={setCardUserId}
        canEmailEveryone={isAdmin}
        onEmailEveryone={() => setEmailOpen(true)}
      />
      {cardUserId && <UserCard userId={cardUserId} onClose={() => setCardUserId(null)} />}
      {emailOpen && sel.workspaceId && (
        <EmailEveryoneModal
          workspaceId={sel.workspaceId}
          workspaceName={ws?.name}
          selfEmail={auth.user.email}
          onClose={() => setEmailOpen(false)}
          onSent={onSent}
        />
      )}
      {/* The one result surface this feature needs; the web client has no
          toast system, and inventing one for a single call site would be a
          bigger change than the feature. */}
      {toast && (
        <div
          data-testid="directory-toast"
          role="status"
          className="fixed bottom-6 left-1/2 z-[60] -translate-x-1/2 rounded-lg bg-ink px-4 py-2.5 text-sm font-semibold text-white shadow-2xl"
        >
          ✓ {toast}
        </div>
      )}
    </>
  );
}
