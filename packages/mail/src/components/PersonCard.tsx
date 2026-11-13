// The person card, as Gmail's: hovering a name or address in an open message (the sender, the "to" line, Details) shows
// who it is, the address with a button that copies it, and what to do next: write to them, find their mail, open or add
// them in Contacts, and, for a member of the organization, open a conversation with them in Chat.
import { createContext, useContext, useState, type ReactNode } from 'react';
import { HoverCard } from 'radix-ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Mail, MessageSquare, Search, UserPlus, UserRound } from 'lucide-react';
import { addressOf, isInHome, openInHome } from '@flow/suite-bar';
import { peopleApi, type Address, type PersonContact } from '../api';
import { cn } from '../lib/utils';

/** What the card's buttons do, from the page (App.tsx through ThreadView); without it a name is plain text. */
export interface PersonActions {
  /** A new message to them. */
  compose(a: Address): void;
  /** Their mail, as a search of the open folder. */
  search(a: Address): void;
  /** The organization the suite bar has active: whose contacts and members the card knows. */
  organizationId: string | null;
}
export const PersonActionsContext = createContext<PersonActions | null>(null);

/** Opens a page of another app: through Home when inside it, else here. */
function go(href: string) {
  if (isInHome()) openInHome(href);
  else window.location.assign(href);
}

/** The contact an address belongs to: one of the person's own first, then a member, a shared one, then anyone written to. */
export function contactFor(contacts: readonly PersonContact[] | undefined, address: string): PersonContact | null {
  const a = address.toLowerCase();
  const rank = (c: PersonContact) => ['own', 'member', 'shared', 'mail'].indexOf(c.source) + 1 || 9;
  return [...(contacts ?? [])].filter((c) => c.emails.some((e) => e.toLowerCase() === a)).sort((x, y) => rank(x) - rank(y))[0] ?? null;
}

/** A name or address in a message header, with the person card on hover (or keyboard focus). */
export function Person({ address, children, className }: { address: Address; children: ReactNode; className?: string }) {
  const actions = useContext(PersonActionsContext);
  if (!actions || !address.address) return <span className={className}>{children}</span>;
  return (
    <HoverCard.Root openDelay={350} closeDelay={150}>
      <HoverCard.Trigger asChild>
        <span tabIndex={0} data-person={address.address} className={cn('cursor-default rounded-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-primary/40', className)}>
          {children}
        </span>
      </HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content side="bottom" align="start" sideOffset={6} collisionPadding={8} className="z-50 w-[340px] rounded-2xl border border-hairline bg-white p-4 text-ink shadow-xl">
          <PersonCard address={address} actions={actions} />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

export function PersonCard({ address: a, actions }: { address: Address; actions: PersonActions }) {
  const qc = useQueryClient();
  const org = actions.organizationId;
  const contacts = useQuery({ queryKey: ['people', 'contacts', org], queryFn: () => peopleApi.contacts(org!), enabled: !!org, staleTime: 5 * 60_000, retry: false });
  const contact = contactFor(contacts.data, a.address);
  const name = contact?.name || a.name || a.address;
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const add = useMutation({
    mutationFn: () => peopleApi.addContact(org!, a.name, a.address),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['people', 'contacts', org] }),
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });
  const chat = useMutation({
    mutationFn: () => peopleApi.dm(org!, contact!.userId!),
    onSuccess: (id) => {
      const href = addressOf({ app: 'chat', kind: 'channel', id });
      if (href) go(href);
    },
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(a.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError('Could not copy: the browser refused.');
    }
  };
  const contactHref = contact && contact.source !== 'mail' ? addressOf({ app: 'contacts', kind: 'contact', id: contact.id }) : null;
  const iconButton = 'flex size-10 shrink-0 items-center justify-center rounded-full border border-border text-ink hover:bg-hover disabled:opacity-50';

  return (
    <div className="flex flex-col gap-3" data-testid="person-card">
      <div className="flex items-start gap-3">
        <span aria-hidden className="flex size-14 shrink-0 items-center justify-center rounded-full bg-primary-tint text-xl font-semibold text-primary-deep">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-lg leading-tight font-medium">{name}</div>
          <div className="mt-0.5 flex items-center gap-1 text-sm text-muted">
            <span className="min-w-0 truncate select-all">{a.address}</span>
            <button type="button" title={copied ? 'Copied' : 'Copy address'} aria-label={copied ? 'Copied' : `Copy ${a.address}`} onClick={() => void copy()} className="flex size-7 shrink-0 items-center justify-center rounded-full hover:bg-hover hover:text-ink">
              {copied ? <Check className="size-4 text-primary" /> : <Copy className="size-4" />}
            </button>
          </div>
          {contact?.source === 'member' && <div className="mt-0.5 text-xs text-muted">Member of your organization</div>}
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button type="button" onClick={() => actions.compose(a)} className="flex h-10 flex-1 items-center justify-center gap-2 rounded-full bg-selected-blue text-sm font-medium text-primary-deep hover:brightness-95">
          <Mail className="size-4" /> Send mail
        </button>
        <button type="button" title="Find emails" aria-label={`Find emails with ${a.address}`} onClick={() => actions.search(a)} className={iconButton}>
          <Search className="size-4" />
        </button>
        {contact?.userId && org && (
          <button type="button" title="Message in Chat" aria-label={`Message ${name} in Chat`} disabled={chat.isPending} onClick={() => chat.mutate()} className={iconButton}>
            <MessageSquare className="size-4" />
          </button>
        )}
        {contactHref ? (
          <a href={contactHref} title="Open in Contacts" aria-label={`Open ${name} in Contacts`} className={iconButton}>
            <UserRound className="size-4" />
          </a>
        ) : (
          org && (
            <button type="button" title={add.isSuccess ? 'Added to Contacts' : 'Add to Contacts'} aria-label={`Add ${name} to Contacts`} disabled={add.isPending || add.isSuccess} onClick={() => add.mutate()} className={iconButton}>
              {add.isSuccess ? <Check className="size-4 text-primary" /> : <UserPlus className="size-4" />}
            </button>
          )
        )}
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
