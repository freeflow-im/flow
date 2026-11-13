// @vitest-environment happy-dom
// Removing someone from the channel in the members popover: only on rows the caller may remove (ChannelView decides:
// an owner or admin anyone, a person their own assistant), asked once more on the row, and the server's refusal shown.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import ChannelMembersPopover, { type MemberRow } from './ChannelMembersPopover';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const row = (name: string, extra: Partial<MemberRow> = {}): MemberRow => ({ userId: `u-${name}`, displayName: name, online: true, ...extra });
let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});
const q = (id: string) => host.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
const click = async (el: HTMLElement | null) => { await act(async () => { el!.click(); }); };

describe('removing a member from the members popover', () => {
  it('shows Remove only on removable rows, and removes after a second click', async () => {
    const removed: string[] = [];
    act(() => root.render(
      <ChannelMembersPopover
        rows={[row('Ann', { isSelf: true }), row('Ada', { isAgent: true, removable: true }), row('Bob')]}
        onSelect={() => {}}
        onRemove={async (id) => { removed.push(id); }}
        onClose={() => {}}
      />,
    ));
    expect(q('channel-member-remove-Ada')).not.toBeNull();
    expect(q('channel-member-remove-Bob')).toBeNull();
    expect(q('channel-member-remove-Ann')).toBeNull();
    await click(q('channel-member-remove-Ada'));
    expect(q('channel-member-remove-Ada')!.textContent).toBe('Remove?');
    expect(removed).toEqual([]);
    await click(q('channel-member-remove-Ada'));
    expect(removed).toEqual(['u-Ada']);
  });

  it('shows the server’s refusal and keeps the member', async () => {
    act(() => root.render(
      <ChannelMembersPopover
        rows={[row('Ada', { removable: true })]}
        onSelect={() => {}}
        onRemove={async () => { throw new Error('only owners and admins can remove members'); }}
        onClose={() => {}}
      />,
    ));
    await click(q('channel-member-remove-Ada'));
    await click(q('channel-member-remove-Ada'));
    expect(q('channel-member-remove-error')!.textContent).toBe('only owners and admins can remove members');
  });

  it('offers no Remove without a handler', () => {
    act(() => root.render(<ChannelMembersPopover rows={[row('Ada', { removable: true })]} onSelect={() => {}} onClose={() => {}} />));
    expect(q('channel-member-remove-Ada')).toBeNull();
  });
});
