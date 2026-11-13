import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ChannelMembersPopover, { orderMembers, type MemberRow } from './ChannelMembersPopover';

const row = (name: string, online: boolean, extra: Partial<MemberRow> = {}): MemberRow => ({
  userId: `u-${name}`,
  displayName: name,
  online,
  ...extra,
});

describe('orderMembers', () => {
  it('puts online members first, then sorts alphabetically', () => {
    const rows = [row('Zoe', false), row('bob', true), row('Alice', false), row('Ada', true)];
    expect(orderMembers(rows).map((m) => m.displayName)).toEqual(['Ada', 'bob', 'Alice', 'Zoe']);
  });

  it('does not mutate the input', () => {
    const rows = [row('Zoe', false), row('Ada', true)];
    orderMembers(rows);
    expect(rows.map((m) => m.displayName)).toEqual(['Zoe', 'Ada']);
  });
});

describe('ChannelMembersPopover render', () => {
  const render = (rows: MemberRow[], loading = false) =>
    renderToStaticMarkup(
      <ChannelMembersPopover rows={rows} loading={loading} onSelect={() => {}} onClose={() => {}} />,
    );

  it('renders a row per member with the agent badge and status', () => {
    const html = render([
      row('Alice', true, { statusEmoji: '🎧', statusText: 'Focusing' }),
      row('CypressBot', false, { isAgent: true }),
    ]);
    expect(html).toContain('channel-member-Alice');
    expect(html).toContain('channel-member-CypressBot');
    expect(html).toContain('Focusing');
    expect(html).toContain('🤖');
    expect(html).toContain('2 members');
  });

  it('marks yourself and singularizes the count', () => {
    const html = render([row('Scott', true, { isSelf: true })]);
    expect(html).toContain('(you)');
    expect(html).toContain('1 member');
    expect(html).not.toContain('1 members');
  });

  it('shows a loading line before the fetch lands, empty state after', () => {
    expect(render([], true)).toContain('Loading…');
    expect(render([], false)).toContain('No members.');
  });

  it('offers Add people only when the channel takes new members', () => {
    expect(render([row('Alice', true)])).not.toContain('channel-add-people');
    const html = renderToStaticMarkup(
      <ChannelMembersPopover rows={[row('Alice', true)]} onSelect={() => {}} onAdd={() => {}} onClose={() => {}} />,
    );
    expect(html).toContain('channel-add-people');
    expect(html).toContain('Add people');
  });
});
