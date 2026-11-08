// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DomainDTO } from '@flow/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.fn();
vi.mock('../lib/useBoundApi', () => ({ useBoundApi: () => ({ api }) }));

import { DomainsSection } from './DomainsSection';

const platform: DomainDTO = { domain: 'acme.freeflow.im', kind: 'platform', verified: true, primary: true, records: [], status: [], createdAt: '' };
const own = (extra: Partial<DomainDTO> = {}): DomainDTO => ({
  domain: 'acme.test', kind: 'own', verified: false, primary: false, createdAt: '',
  records: [
    { type: 'TXT', name: '_freeflow.acme.test', value: 'freeflow-verify=abc', purpose: 'verification' },
    { type: 'MX', name: 'acme.test', value: 'mx.example.invalid', priority: 10, purpose: 'mx' },
  ],
  status: [{ record: 'present' }, { record: 'missing' }],
  ...extra,
});

let root: Root;
let host: HTMLDivElement;
const one = (id: string) => host.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const all = (id: string) => [...host.querySelectorAll(`[data-testid="${id}"]`)] as HTMLElement[];
const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const click = (id: string) => act(async () => { one(id)!.click(); });

async function mount(list: () => DomainDTO[]) {
  api.mockImplementation(async (method: string, path: string) => {
    if (method === 'GET') return { domains: list() };
    if (path.endsWith('/verify')) return { verified: false, found: [] };
    return {};
  });
  await act(async () => { root.render(<DomainsSection workspaceId="w1" />); });
  await flush();
}

beforeEach(() => {
  api.mockReset();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe('the Domains tab', () => {
  it('lists the platform domain as verified and primary, with no records or actions', async () => {
    await mount(() => [platform]);
    expect(api).toHaveBeenCalledWith('GET', '/v1/workspaces/w1/domains');
    expect(one('domain-verified-acme-freeflow-im')!.textContent).toBe('verified');
    expect(one('domain-primary-acme-freeflow-im')).not.toBeNull();
    expect(one('domain-records-acme-freeflow-im')).toBeNull();
    expect(one('domain-remove-acme-freeflow-im')).toBeNull();
    expect(one('domain-make-primary-acme-freeflow-im')).toBeNull();
  });

  it('shows an own domain\'s records with their status and a Copy each, and offers Verify', async () => {
    await mount(() => [platform, own()]);
    const rows = all('domain-record');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain('_freeflow.acme.test');
    expect(rows[1]!.textContent).toContain('10 mx.example.invalid');
    expect(all('domain-record-status').map((s) => s.textContent)).toEqual(['✓ present', 'missing']);
    expect(all('domain-record-copy')).toHaveLength(2);
    expect(one('domain-make-primary-acme-test')).toBeNull();
    await click('domain-verify-acme-test');
    expect(api).toHaveBeenCalledWith('POST', '/v1/workspaces/w1/domains/acme.test/verify');
    expect(one('domain-note-acme-test')!.textContent).toContain('not found yet');
    await click('domain-recheck-acme-test');
    expect(api).toHaveBeenCalledWith('GET', '/v1/workspaces/w1/domains?refresh=1');
  });

  it('adds a domain, makes a verified one primary, and removes after a confirm', async () => {
    let list = [platform];
    await mount(() => list);
    const input = one('domain-add-input') as HTMLInputElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'acme.test');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    list = [platform, own({ verified: true })];
    await click('domain-add');
    expect(api).toHaveBeenCalledWith('POST', '/v1/workspaces/w1/domains', { domain: 'acme.test' });
    await click('domain-make-primary-acme-test');
    expect(api).toHaveBeenCalledWith('PATCH', '/v1/workspaces/w1/domains/acme.test', { primary: true });
    await click('domain-remove-acme-test');
    expect(api).not.toHaveBeenCalledWith('DELETE', expect.anything());
    await click('domain-remove-confirm-acme-test');
    expect(api).toHaveBeenCalledWith('DELETE', '/v1/workspaces/w1/domains/acme.test');
  });

  it('shows a refusal', async () => {
    await mount(() => [platform, own({ verified: true })]);
    api.mockImplementation(async (method: string) => {
      if (method === 'DELETE') throw new Error('accounts have addresses on this domain');
      return { domains: [platform, own({ verified: true })] };
    });
    await click('domain-remove-acme-test');
    await click('domain-remove-confirm-acme-test');
    expect(one('domain-error-acme-test')!.textContent).toBe('accounts have addresses on this domain');
  });
});
