// A member's addresses (platform.md §3.2, decision_log 2026-11-16), from the Members roster: the one they go by, which mail
// is sent as, and the others that deliver to their mailbox. An admin adds an alias, makes another address the one they go
// by, or removes an alias. The mailbox's own address (the one it was made with) always delivers and cannot be removed.
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { AccountAddressesDTO, AccountDTO, WorkspaceDTO } from '@flow/shared';
import { adminApi } from '../api';
import { Modal } from '../components/Modal';
import { Button, ErrorLine, Select } from '../components/ui';

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function AddressesModal({ org, account, name, isAgent, onClose, onChanged }: { org: WorkspaceDTO; account: AccountDTO; name: string; isAgent: boolean; onClose(): void; onChanged(): Promise<unknown> | void }) {
  const qc = useQueryClient();
  const key = ['addresses', org.id, account.id];
  const list = useQuery({ queryKey: key, queryFn: () => adminApi.addresses(org.id, account.id) });
  const domains = useQuery({ queryKey: ['domains', org.id], queryFn: () => adminApi.domains(org.id) });
  // A person's addresses are on the organization's own domains with mail on; an agent's may be on the platform one too.
  const usable = (domains.data ?? []).filter((d) => d.verified && d.atProvider && (d.kind === 'own' || isAgent)).map((d) => d.domain);
  const [local, setLocal] = useState('');
  const [domain, setDomain] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const chosenDomain = domain ?? usable[0] ?? '';

  const act = <V,>(fn: (v: V) => Promise<AccountAddressesDTO | { addresses: AccountAddressesDTO }>) =>
    useMutation({
      mutationFn: fn,
      onMutate: () => setError(null),
      onSuccess: async (out) => {
        qc.setQueryData(key, 'addresses' in out ? out.addresses : out);
        await onChanged();
      },
      onError: (e) => setError(errorText(e)),
    });
  const add = act((address: string) => adminApi.addAddress(org.id, account.id, address));
  const remove = act((address: string) => adminApi.removeAddress(org.id, account.id, address));
  const use = act((address: string) => adminApi.changeAddress(org.id, account.id, address));
  const busy = add.isPending || remove.isPending || use.isPending;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const l = local.trim().toLowerCase();
    if (!l || !chosenDomain) return;
    add.mutate(`${l}@${chosenDomain}`, { onSuccess: () => setLocal('') });
  };

  const data = list.data;
  return (
    <Modal title={`Addresses of ${name}`} onClose={onClose} testid="addresses-modal">
      <div className="flex flex-col gap-4 text-sm">
        <p className="text-muted">Mail to any of these reaches {name}'s mailbox. Mail they send comes from the main address.</p>
        {list.isError && <ErrorLine error={errorText(list.error)} />}
        {data && (
          <ul className="divide-y divide-hairline rounded-md border border-border" data-testid="addresses-list">
            <li className="flex items-center gap-2 px-3 py-2" data-testid="address-main">
              <span className="min-w-0 flex-1 truncate font-medium">{data.address}</span>
              <span className="rounded-full bg-primary-tint px-2 py-0.5 text-xs font-semibold text-primary-deep">main</span>
            </li>
            {data.others.map((o) => (
              <li key={o.address} className="flex items-center gap-3 px-3 py-2" data-testid={`address-other-${o.address}`}>
                <span className="min-w-0 flex-1 truncate">{o.address}</span>
                <Button kind="link" disabled={busy} onClick={() => use.mutate(o.address)} testid={`address-use-${o.address}`}>
                  Make main
                </Button>
                {o.removable ? (
                  <Button kind="link" disabled={busy} onClick={() => remove.mutate(o.address)} testid={`address-remove-${o.address}`}>
                    Remove
                  </Button>
                ) : (
                  <span className="text-xs text-faint" title="The mailbox was made with this address; it always delivers.">
                    mailbox
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        {usable.length ? (
          <form className="flex flex-wrap items-center gap-2" onSubmit={submit} data-testid="address-add-form">
            <input
              className="w-40 rounded-md border border-border px-2 py-1 text-sm"
              placeholder="name"
              aria-label="New address, before @"
              value={local}
              onChange={(e) => setLocal(e.target.value)}
              data-testid="address-add-local"
            />
            <span className="text-muted">@</span>
            {usable.length > 1 ? (
              <Select compact label="Domain" value={chosenDomain} options={usable.map((d) => ({ value: d, label: d }))} onChange={setDomain} testid="address-add-domain" />
            ) : (
              <span>{chosenDomain}</span>
            )}
            <Button type="submit" kind="primary" disabled={busy || !local.trim()} testid="address-add">
              {add.isPending ? 'Adding…' : 'Add address'}
            </Button>
          </form>
        ) : (
          domains.isSuccess && <p className="text-xs text-muted">Turn on mail for a domain of your own (Domains & mail) to add addresses.</p>
        )}
        <ErrorLine error={error} testid="addresses-error" />
      </div>
    </Modal>
  );
}
