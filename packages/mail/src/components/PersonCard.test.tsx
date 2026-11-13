// The person card (PersonCard.tsx): who it is, the address and its copy button, Send mail and Find emails, and Contacts and
// Chat by what the organization's address book knows of them.
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, PersonContact } from '../api';
import { contactFor, PersonCard, type PersonActions } from './PersonCard';

const contacts: PersonContact[] = [
  { id: 'c-mail', source: 'mail', name: 'Puneet (from mail)', emails: ['puneet@trueventures.com'] },
  { id: 'c-own', source: 'own', name: 'Puneet Agarwal', emails: ['Puneet@TrueVentures.com'] },
  { id: 'c-ann', source: 'member', name: 'Ann Lee', emails: ['ann@acme.test'], userId: 'u-ann' },
];
let calls: { method: string; url: string; body?: unknown }[];
let root: Root | null = null;
let host: HTMLDivElement;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const cleanup = () => {
  if (root) act(() => root!.unmount());
  root = null;
  host?.remove();
};
const settle = () => act(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0)); });
const byText = (text: string) => [...document.querySelectorAll<HTMLElement>('body *')].find((el) => el.children.length === 0 && el.textContent?.trim() === text) ?? null;
const button = (label: string | RegExp) =>
  [...document.querySelectorAll<HTMLButtonElement>('button')].find((b) => (typeof label === 'string' ? b.getAttribute('aria-label') === label || b.textContent?.trim() === label : label.test(b.getAttribute('aria-label') ?? b.textContent ?? ''))) ?? null;
const link = (label: string) => document.querySelector<HTMLAnchorElement>(`a[aria-label="${label}"]`);
const click = (el: HTMLElement | null) => act(() => { el!.click(); });

beforeEach(() => {
  calls = [];
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    calls.push({ method: init?.method ?? 'GET', url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (url.startsWith('/v1/contacts') && (init?.method ?? 'GET') === 'GET') return new Response(JSON.stringify({ contacts }), { status: 200 });
    if (url.startsWith('/v1/contacts')) return new Response(JSON.stringify({ contact: { id: 'c-new', source: 'own', name: 'New', emails: ['new@x.test'] } }), { status: 201 });
    if (url.includes('/dms')) return new Response(JSON.stringify({ id: 'ch-1' }), { status: 200 });
    return new Response('{}', { status: 404 });
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const show = async (address: Address, actions: Partial<PersonActions> = {}) => {
  const all: PersonActions = { organizationId: 'o1', compose: vi.fn(), search: vi.fn(), ...actions };
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root!.render(createElement(QueryClientProvider, { client: qc }, createElement(PersonCard, { address, actions: all }))));
  await settle();
  return all;
};

describe('the person card', () => {
  it('shows the name and address, and copies the address', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await show({ name: 'Bob Stone', address: 'bob@x.test' });
    expect(byText('Bob Stone')).toBeTruthy();
    expect(byText('bob@x.test')).toBeTruthy();
    await click(button('Copy bob@x.test'));
    await settle();
    expect(writeText).toHaveBeenCalledWith('bob@x.test');
    expect(button('Copied')).toBeTruthy();
  });

  it('writes to them and finds their mail', async () => {
    const a = { name: 'Bob Stone', address: 'bob@x.test' };
    const actions = await show(a);
    await click(button(/Send mail/));
    await click(button('Find emails with bob@x.test'));
    expect(actions.compose).toHaveBeenCalledWith(a);
    expect(actions.search).toHaveBeenCalledWith(a);
  });

  it('names a known contact by its own name and opens it in Contacts; a stranger can be added', async () => {
    await show({ name: 'Puneet', address: 'puneet@trueventures.com' });
    expect(byText('Puneet Agarwal')).toBeTruthy();
    expect(link('Open Puneet Agarwal in Contacts')!.getAttribute('href')).toBe('/contacts/?contact=c-own');
    expect(calls[0]!.url).toBe('/v1/contacts?workspace=o1');
    cleanup();
    await show({ name: 'New Person', address: 'new@x.test' });
    await click(button('Add New Person to Contacts'));
    await settle();
    expect(calls.find((c) => c.method === 'POST')!.body).toMatchObject({ name: 'New Person', emails: ['new@x.test'] });
    expect(button('Add New Person to Contacts')!.disabled).toBe(true);
  });

  it('offers Chat for a member of the organization', async () => {
    await show({ name: 'Ann', address: 'ann@acme.test' });
    expect(byText('Member of your organization')).toBeTruthy();
    expect(button('Message Ann Lee in Chat')).toBeTruthy();
  });
});

describe('contactFor', () => {
  it('matches the address whatever its case, an own contact before one only written to', () => {
    expect(contactFor(contacts, 'PUNEET@trueventures.com')?.id).toBe('c-own');
    expect(contactFor(contacts, 'nobody@x.test')).toBeNull();
    expect(contactFor(undefined, 'a@b.test')).toBeNull();
  });
});
