// The left panel, after shadcn/ui's Mail example's nav (MIT, see LICENSE-shadcn.md) and coloured like Docs' folder
// panel: Compose, the account switcher (with more than one account), the special folders with their icons, the other
// folders as a tree, and at the foot Add account and the accounts' settings. Messages dragged from the list drop on a
// folder to move them there (lib/dnd.ts).
import { useState, type ComponentType } from 'react';
import { Archive, ChevronDown, ChevronRight, File, Folder, Inbox, Mail, OctagonAlert, Pencil, Plus, Send, Settings, Star, Trash2, type LucideProps } from 'lucide-react';
import type { MailAccount, MailFolder, SpecialUse } from '../api';
import { useDropTarget } from '../lib/dnd';
import { folderLabel, orderFolders, type FolderNode } from '../lib/folders';
import { cn } from '../lib/utils';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from './ui/dropdown-menu';

const ICONS: Record<SpecialUse, ComponentType<LucideProps>> = {
  inbox: Inbox,
  flagged: Star,
  drafts: File,
  sent: Send,
  archive: Archive,
  all: Mail,
  junk: OctagonAlert,
  trash: Trash2,
};

export interface SidebarProps {
  accounts: MailAccount[];
  account: MailAccount | null;
  onAccount(id: string): void;
  folders: MailFolder[] | undefined;
  folder: string | null;
  onFolder(path: string): void;
  onCompose(): void;
  onAddAccount(): void;
  onSettings(): void;
  /** Messages dropped on a folder (dragged from the list). */
  onDropMessages?: ((path: string, uids: number[]) => void) | undefined;
}

/** Highlighted while dragged messages are over it. */
const dropOver = 'bg-primary-tint ring-2 ring-primary ring-inset hover:bg-primary-tint';

const row = 'flex h-[34px] w-full items-center gap-3 rounded-lg px-3 text-left text-sm text-ink transition-colors hover:bg-hover';
const selected = 'bg-row-selected font-semibold hover:bg-row-selected';

function Count({ n }: { n: number }) {
  return n > 0 ? <span className="ml-auto pl-2 text-xs tabular-nums text-muted">{n > 9999 ? '9999+' : n}</span> : null;
}

function Avatar({ name, email }: { name: string; email: string }) {
  const letter = (name || email).trim().slice(0, 1).toUpperCase();
  return <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] font-semibold text-white">{letter}</span>;
}

function TreeRow({ node, depth, folder, onFolder, onDrop }: { node: FolderNode; depth: number; folder: string | null; onFolder(path: string): void; onDrop: SidebarProps['onDropMessages'] }) {
  const [open, setOpen] = useState(true);
  const has = node.children.length > 0;
  const f = node.folder;
  const drop = useDropTarget(f && onDrop ? (uids) => onDrop(f.path, uids) : undefined);
  return (
    <>
      <div className="relative">
        <button
          type="button"
          {...drop.props}
          className={cn(row, f && folder === f.path && selected, !f && 'cursor-default hover:bg-transparent', drop.over && dropOver)}
          style={{ paddingLeft: 12 + depth * 16 }}
          onClick={() => (f ? onFolder(f.path) : setOpen(!open))}
          aria-current={f && folder === f.path ? 'page' : undefined}
        >
          <Folder className="size-4 shrink-0 text-muted" strokeWidth={1.75} />
          <span className="truncate">{node.name}</span>
          {f && <Count n={f.unread} />}
        </button>
        {has && (
          <button
            type="button"
            aria-label={open ? `Collapse ${node.name}` : `Expand ${node.name}`}
            className="absolute top-[9px] flex size-4 items-center justify-center rounded text-muted hover:bg-row-selected"
            style={{ left: depth * 16 - 2 }}
            onClick={() => setOpen(!open)}
          >
            {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
          </button>
        )}
      </div>
      {has && open && node.children.map((c) => <TreeRow key={c.path} node={c} depth={depth + 1} folder={folder} onFolder={onFolder} onDrop={onDrop} />)}
    </>
  );
}

function SpecialRow({ f, current, onFolder, onDrop }: { f: MailFolder; current: boolean; onFolder(path: string): void; onDrop: SidebarProps['onDropMessages'] }) {
  const Icon = ICONS[f.specialUse!];
  const drop = useDropTarget(onDrop ? (uids) => onDrop(f.path, uids) : undefined);
  // Unread counts on the folders where they mean something to do.
  const count = f.specialUse === 'inbox' || f.specialUse === 'junk' || f.specialUse === 'archive' ? f.unread : f.specialUse === 'drafts' ? f.total : 0;
  return (
    <button type="button" {...drop.props} className={cn(row, current && selected, drop.over && dropOver)} onClick={() => onFolder(f.path)} aria-current={current ? 'page' : undefined}>
      <Icon className="size-4 shrink-0" strokeWidth={1.75} />
      <span className="truncate">{folderLabel(f)}</span>
      <Count n={count} />
    </button>
  );
}

export function Sidebar(p: SidebarProps) {
  const { special, tree } = orderFolders(p.folders ?? []);
  return (
    <nav className="flex h-full flex-col bg-panel text-ink" aria-label="Mail folders">
      <div className="px-3 pt-3 pb-2">
        <button
          type="button"
          onClick={p.onCompose}
          className="flex h-11 items-center gap-3 rounded-2xl bg-primary-tint px-5 text-sm font-semibold text-[#001d35] shadow-sm transition-shadow hover:shadow-md"
          title="Compose (c)"
        >
          <Pencil className="size-4" strokeWidth={2} />
          Compose
        </button>
      </div>

      {p.accounts.length > 1 && p.account && (
        <div className="px-2 pb-1">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button type="button" className={cn(row, 'gap-2 px-2')} aria-label="Switch account">
                <Avatar name={p.account.displayName} email={p.account.email} />
                <span className="min-w-0 flex-1 truncate">{p.account.email}</span>
                <ChevronDown className="size-4 text-muted" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="w-[var(--radix-dropdown-menu-trigger-width)]">
              {p.accounts.map((a) => (
                <DropdownMenuItem key={a.id} onSelect={() => p.onAccount(a.id)} className={cn(a.id === p.account?.id && 'font-semibold')}>
                  <Avatar name={a.displayName} email={a.email} />
                  <span className="min-w-0 flex-1 truncate">{a.email}</span>
                  {a.status !== 'ok' && <span className="text-xs text-danger">!</span>}
                </DropdownMenuItem>
              ))}
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={p.onAddAccount}>
                <Plus /> Add account
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {!p.folders && (
          <div className="space-y-1 px-1 pt-1" aria-hidden>
            {[0, 1, 2, 3].map((i) => (
              <div key={i} className="h-[34px] animate-pulse rounded-lg bg-hover" />
            ))}
          </div>
        )}
        {special.map((f) => (
          <SpecialRow key={f.path} f={f} current={p.folder === f.path} onFolder={p.onFolder} onDrop={p.onDropMessages} />
        ))}
        {tree.length > 0 && (
          <>
            <div className="px-3 pt-4 pb-1 text-[11px] font-medium uppercase tracking-[.06em] text-muted">Folders</div>
            {tree.map((n) => (
              <TreeRow key={n.path} node={n} depth={0} folder={p.folder} onFolder={p.onFolder} onDrop={p.onDropMessages} />
            ))}
          </>
        )}
      </div>

      <div className="border-t border-hairline px-2 py-2">
        <button type="button" className={cn(row, 'text-muted')} onClick={p.onAddAccount}>
          <Plus className="size-4" strokeWidth={1.75} />
          Add account
        </button>
        <button type="button" className={cn(row, 'text-muted')} onClick={p.onSettings}>
          <Settings className="size-4" strokeWidth={1.75} />
          Account settings
        </button>
      </div>
    </nav>
  );
}
