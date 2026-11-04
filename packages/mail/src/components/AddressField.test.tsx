// The address field's completion: suggestions under the box as the person types, taken with the keyboard or a click.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Address, Contact } from '../api';
import { AddressField, SUGGEST_DELAY_MS } from './AddressField';

const CONTACTS: Contact[] = [
  { name: 'Lee Phillips', address: 'lee@legora.com', sent: 3, received: 2, lastAt: 1 },
  { name: '', address: 'leo@example.com', sent: 0, received: 1, lastAt: 1 },
];

let root: Root, host: HTMLDivElement;
beforeEach(() => { host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); });

const sleep = (ms: number) => act(() => new Promise((r) => setTimeout(r, ms)));
function render(onChange: (next: Address[]) => void, suggest: (q: string) => Promise<Contact[]>, value: Address[] = []) {
  act(() => root.render(createElement(AddressField, { label: 'To', value, onChange, suggest })));
  return host.querySelector('input')!;
}
function type(input: HTMLInputElement, text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { setter.call(input, text); input.dispatchEvent(new Event('input', { bubbles: true })); });
}
const key = (input: HTMLInputElement, k: string) => act(() => { input.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });

describe('AddressField completion', () => {
  it('asks for contacts after a pause in typing, and shows them; Enter takes the first', async () => {
    const onChange = vi.fn();
    const suggest = vi.fn(async (q: string) => CONTACTS.filter((c) => c.address.startsWith(q) || c.name.toLowerCase().includes(q)));
    const input = render(onChange, suggest);
    type(input, 'l');
    type(input, 'le');
    expect(host.querySelector('[role=listbox]')).toBeNull();
    await sleep(SUGGEST_DELAY_MS + 40);
    expect(suggest).toHaveBeenCalledTimes(1);
    expect(suggest).toHaveBeenLastCalledWith('le');
    const options = [...host.querySelectorAll('[role=option]')].map((o) => o.textContent);
    expect(options).toEqual(['Lee Phillipslee@legora.com', 'leo@example.com']);
    expect(host.querySelector('[role=option][aria-selected=true]')?.textContent).toContain('Lee Phillips');
    key(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith([{ name: 'Lee Phillips', address: 'lee@legora.com' }]);
    expect(host.querySelector('[role=listbox]')).toBeNull();
    expect(input.value).toBe('');
  });

  it('moves with the arrows, picks with Tab or a click, dismisses with Esc, and leaves out addresses already chosen', async () => {
    const onChange = vi.fn();
    const input = render(onChange, async () => CONTACTS, [{ name: 'Lee Phillips', address: 'lee@legora.com' }]);
    type(input, 'le');
    await sleep(SUGGEST_DELAY_MS + 40);
    expect([...host.querySelectorAll('[role=option]')].map((o) => o.textContent)).toEqual(['leo@example.com']);
    key(input, 'Escape');
    expect(host.querySelector('[role=listbox]')).toBeNull();
    type(input, 'leo');
    await sleep(SUGGEST_DELAY_MS + 40);
    key(input, 'ArrowDown');
    key(input, 'Tab');
    expect(onChange).toHaveBeenLastCalledWith([{ name: 'Lee Phillips', address: 'lee@legora.com' }, { name: '', address: 'leo@example.com' }]);
    type(input, 'le');
    await sleep(SUGGEST_DELAY_MS + 40);
    act(() => { (host.querySelector('[role=option]') as HTMLElement).click(); });
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it('without a suggestion, Enter still makes a chip of what was typed', async () => {
    const onChange = vi.fn();
    const input = render(onChange, async () => []);
    type(input, 'new@example.com');
    await sleep(SUGGEST_DELAY_MS + 40);
    key(input, 'Enter');
    expect(onChange).toHaveBeenCalledWith([{ name: '', address: 'new@example.com' }]);
  });
});
