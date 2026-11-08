// Where a file or folder lives in the FreeFlow suite (docs/specs/freeflow-suite.md §2.4, ruled 2026-11-02): an
// organization's shared files (Organization files) or the user's own files in it (My files). The row and folder menus
// of the home page and each editor's File menu offer Share… (ShareWithDialog: people, channels, the organization, a
// link), Share with organization, Make private and, for someone in more than one organization, Move to organization…
// (the same root in another organization). They are grant changes on the server (server/access.ts): the first two a
// manager's, the move the owner's, so the menus offer them by the user's role.
import { useState, type ReactNode } from 'react';
import { api, type Place } from '../api.ts';
import { useAuth } from '../auth.tsx';
import { useOrganization } from '../organization.ts';
import type { MenuItem } from './Menu.tsx';
import { Modal } from './Modal.tsx';
import { ShareWithDialog } from './ShareWithDialog.tsx';

/** What the menus need of a file: its id, and its organization and root as the server tells them (SheetMeta, StoredFile). */
export interface Scoped {
  id: string;
  folder?: string;
  workspaceId?: string;
  shared?: true;
  /** The user's role on someone else's file (none for their own). */
  role?: 'viewer' | 'editor' | 'manager';
}

/** A page's file metadata after a move to another root: its new folder, organization and root, the rest as it was. */
export const withScope = <T extends Scoped>(cur: T, m: Scoped): T => ({ ...cur, folder: m.folder, workspaceId: m.workspaceId, shared: m.shared });

/** The actions for a file or folder in a root, by label: what each menu shows (null outside the suite). */
export function scopeActionLabels(item: { shared?: true }, organizations: number): { share: string; move: string | null } {
  return { share: item.shared ? 'Make private' : 'Share with organization', move: organizations > 1 ? 'Move to organization…' : null };
}

/** Pick one of the user's other organizations to move a file or folder to; it keeps being shared or private. */
export function OrganizationPicker(props: { title: string; current: string | null; shared: boolean; onPick(workspace: string): Promise<void>; onClose(): void }) {
  const { organizations } = useOrganization();
  const others = organizations.filter((o) => o.id !== props.current);
  const [picked, setPicked] = useState<string | null>(others[0]?.id ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={`Move “${props.title}” to another organization`} onClose={props.onClose}>
      <p className="muted org-picker-note">{props.shared ? 'It goes to that organization’s files, for its members.' : 'It stays private to you, in your files there.'}</p>
      <div className="folder-picker org-picker" role="radiogroup" aria-label="Organization">
        {others.map((o) => (
          <button key={o.id} role="radio" aria-checked={picked === o.id} className={picked === o.id ? 'active' : undefined} onClick={() => setPicked(o.id)}>
            <span className="org-picker-mark" aria-hidden="true">
              {o.name.slice(0, 1).toUpperCase()}
            </span>
            {o.name}
          </button>
        ))}
        {!others.length && <div className="muted">You are not in another organization.</div>}
      </div>
      {error && <div className="form-error">{error}</div>}
      <div className="modal-actions">
        <button className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button
          className="btn primary"
          disabled={busy || !picked}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await props.onPick(picked!);
              props.onClose();
            } catch (e) {
              setError(e instanceof Error ? e.message : String(e));
              setBusy(false);
            }
          }}
        >
          Move
        </button>
      </div>
    </Modal>
  );
}

/**
 * An editor's File menu items for the open file (none outside the suite), and the picker they may open. `changed`
 * is told the file's new metadata, so the page's breadcrumbs name its new root.
 */
export function useOrganizationMenu(file: (Scoped & { title: string; kind?: string; type?: string }) | null, changed: (meta: Scoped) => void, onError: (message: string) => void): { items: MenuItem[]; dialog: ReactNode } {
  const { suite } = useAuth();
  const org = useOrganization();
  const [picking, setPicking] = useState(false);
  const [sharing, setSharing] = useState(false);
  if (!suite || !file || !org.active) return { items: [], dialog: null };
  // A document of any kind has a `kind`; a stored file (FilePage) a `type`.
  const objectKind = file.kind ? 'sheet' : 'file';
  const labels = scopeActionLabels(file, org.organizations.length);
  const move = async (target: { shared: boolean; workspace?: string }) => {
    const { file: meta } = await api.setFileScope(file.id, { workspace: target.workspace ?? file.workspaceId ?? org.active!.id, shared: target.shared });
    changed(meta);
  };
  return {
    items: [
      { label: 'Share…', action: () => setSharing(true) },
      ...(!file.role || file.role === 'manager' ? [{ label: labels.share, action: () => void move({ shared: !file.shared }).catch((e: Error) => onError(e.message)) }] : []),
      ...(labels.move && !file.role ? [{ label: labels.move, action: () => setPicking(true) }] : []),
      'sep',
    ],
    dialog: (
      <>
        {picking && <OrganizationPicker title={file.title} current={file.workspaceId ?? org.active.id} shared={!!file.shared} onPick={(workspace) => move({ shared: !!file.shared, workspace })} onClose={() => setPicking(false)} />}
        {sharing && (
          <ShareWithDialog
            kind={objectKind}
            id={file.id}
            name={file.title}
            linkable={file.kind === 'deck' || (!!file.type && file.type.startsWith('video/'))}
            onClose={() => setSharing(false)}
            onMoved={(shared) => changed({ ...file, ...(shared ? { shared: true } : { shared: undefined }) })}
          />
        )}
      </>
    ),
  };
}

/** The root a file is in, as a place in the library (its folder there), for its breadcrumbs. */
export const rootName = (file: { shared?: true } | null | undefined, inSuite: boolean): string | null => (inSuite ? (file?.shared ? 'Organization files' : 'My files') : null);

export type { Place };
