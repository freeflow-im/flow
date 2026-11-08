import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MobileNavContext } from '../state';
import { DirectoryGrid, filterMembers, type DirectoryRow } from './DirectoryView';

const row = (name: string, extra: Partial<DirectoryRow> = {}): DirectoryRow => ({
  userId: `u-${name}`,
  displayName: name,
  email: `${name.toLowerCase()}@example.com`,
  avatarUrl: null,
  statusEmoji: '',
  statusText: '',
  title: '',
  isAgent: false,
  isBot: false,
  sponsorId: null,
  privacyMode: false,
  role: 'member',
  joinedAt: '2026-08-30T00:00:00.000Z',
  sponsorName: null,
  online: false,
  isSelf: false,
  ...extra,
});

describe('filterMembers', () => {
  it('sorts alphabetically, case-insensitively, agents mixed in with humans', () => {
    const rows = [row('zoe'), row('CypressBot', { isAgent: true }), row('Ada')];
    expect(filterMembers(rows, '').map((m) => m.displayName)).toEqual(['Ada', 'CypressBot', 'zoe']);
  });

  it('narrows by a case-insensitive substring of the name', () => {
    const rows = [row('Ada Lovelace'), row('Alan Turing')];
    expect(filterMembers(rows, 'ada').map((m) => m.displayName)).toEqual(['Ada Lovelace']);
    expect(filterMembers(rows, 'TUR').map((m) => m.displayName)).toEqual(['Alan Turing']);
  });

  it('also matches the email local part, but never the domain', () => {
    const rows = [row('Scott', { email: 'scottp@biztrip.ai' }), row('Ada')];
    expect(filterMembers(rows, 'scottp').map((m) => m.displayName)).toEqual(['Scott']);
    // "example" would otherwise match every member through their domain.
    expect(filterMembers(rows, 'biztrip')).toEqual([]);
  });

  it('ignores an agent\u2019s synthetic address', () => {
    // agent-<uuid>@agents.flow.local — matching it is only ever an accident.
    const rows = [row('Prism', { isAgent: true, email: 'agent-01a0-beef@agents.flow.local' })];
    expect(filterMembers(rows, 'prism').map((m) => m.displayName)).toEqual(['Prism']);
    expect(filterMembers(rows, 'beef')).toEqual([]);
  });

  // #489: hidden from the listing *and* from search — findable by typing a name
  // you already know would not be hidden at all.
  it('leaves out a member in privacy mode, whoever is looking', () => {
    const rows = [row('Ada'), row('Hilda', { privacyMode: true, email: '' }), row('Zoe')];
    expect(filterMembers(rows, '').map((m) => m.displayName)).toEqual(['Ada', 'Zoe']);
    expect(filterMembers(rows, 'hilda')).toEqual([]);
    // themselves included — the settings toggle is the confirmation, not a
    // card only they can see
    const self = [row('Hilda', { privacyMode: true, email: '', isSelf: true })];
    expect(filterMembers(self, '')).toEqual([]);
  });

  it('still finds a member who turned privacy mode back off', () => {
    const rows = [row('Hilda', { privacyMode: false })];
    expect(filterMembers(rows, 'hilda').map((m) => m.displayName)).toEqual(['Hilda']);
  });

  it('does not mutate the input', () => {
    const rows = [row('zoe'), row('Ada')];
    filterMembers(rows, '');
    expect(rows.map((m) => m.displayName)).toEqual(['zoe', 'Ada']);
  });
});

describe('DirectoryGrid render', () => {
  const render = (rows: DirectoryRow[], query = '', loading = false, canEmailEveryone = false) =>
    renderToStaticMarkup(
      // The pane header carries the mobile hamburger, which reads the nav context.
      <MobileNavContext.Provider value={{ isMobile: false, drawerOpen: false, openDrawer: () => {}, closeDrawer: () => {} }}>
        <DirectoryGrid
          rows={rows}
          loading={loading}
          query={query}
          onQuery={() => {}}
          onSelect={() => {}}
          canEmailEveryone={canEmailEveryone}
          onEmailEveryone={() => {}}
        />
      </MobileNavContext.Provider>,
    );

  it('draws a card per member with role, status and the agent badge', () => {
    const html = render([
      row('Ada', { role: 'owner', statusEmoji: '🎧', statusText: 'Focusing', online: true }),
      row('CypressBot', { isAgent: true, sponsorName: 'Ada' }),
    ]);
    expect(html).toContain('directory-card-Ada');
    expect(html).toContain('directory-card-CypressBot');
    expect(html).toContain('Owner');
    expect(html).toContain('Focusing');
    expect(html).toContain('AI agent');
    expect(html).toContain('🤖');
    expect(html).toContain('2 people');
    // An agent names its sponsor where a human shows their email.
    expect(html).toContain('Sponsored by Ada');
    expect(html).not.toContain('cypressbot@example.com');
  });

  it('marks yourself and singularizes the count', () => {
    const html = render([row('Scott', { isSelf: true })]);
    expect(html).toContain('(you)');
    expect(html).toContain('1 person');
    expect(html).not.toContain('1 people');
  });

  it('renders only the members matching the query', () => {
    const html = render([row('Ada'), row('Zoe')], 'ada');
    expect(html).toContain('directory-card-Ada');
    expect(html).not.toContain('directory-card-Zoe');
  });

  // #434: the title is the member's own line, and an absent one is absent —
  // a reserved blank line would make every card without a title look broken.
  it('shows a title under the name when set, and no line at all when unset', () => {
    const withTitle = render([row('Ada', { title: 'Founder, Biztrip AI' })]);
    expect(withTitle).toContain('directory-card-title');
    expect(withTitle).toContain('Founder, Biztrip AI');
    expect(render([row('Ada')])).not.toContain('directory-card-title');
    expect(render([row('Ada', { title: '' })])).not.toContain('directory-card-title');
  });

  it('shows the member\u2019s address under the name when the server sent one', () => {
    const html = render([row('Ada', { address: 'ada@acme.freeflow.im' })]);
    expect(html).toContain('directory-card-address');
    expect(html).toContain('ada@acme.freeflow.im');
    expect(render([row('Ada')])).not.toContain('directory-card-address');
  });

  it('keeps an agent\u2019s Sponsored by line when the agent also has a title', () => {
    const html = render([row('CypressBot', { isAgent: true, sponsorName: 'Ada', title: 'Release bot' })]);
    expect(html).toContain('Release bot');
    expect(html).toContain('Sponsored by Ada');
    expect(html).toContain('AI agent');
  });

  it('draws no card, and no count, for a member in privacy mode (#489)', () => {
    const html = render([row('Ada'), row('Hilda', { privacyMode: true, email: '' })]);
    expect(html).toContain('directory-card-Ada');
    expect(html).not.toContain('directory-card-Hilda');
    expect(html).not.toContain('hilda@example.com');
    expect(html).toContain('1 person');
  });

  it('distinguishes loading, an empty workspace, and a query with no match', () => {
    expect(render([], '', true)).toContain('Loading…');
    expect(render([], '')).toContain('Nobody is here yet.');
    // A roster that loaded but matches nothing must not read as "empty workspace".
    const noMatch = render([row('Ada')], 'zzz');
    expect(noMatch).toContain('directory-empty');
    expect(noMatch).not.toContain('Nobody is here yet.');
  });

  // #481: the broadcast entry point is owner/admin only. The server enforces
  // it again, but a member should never see a button they can't use.
  it('shows Email everyone only when the viewer is an owner or admin', () => {
    expect(render([row('Ada')], '', false, true)).toContain('directory-email-everyone');
    expect(render([row('Ada')], '', false, true)).toContain('Email everyone');
    expect(render([row('Ada')], '', false, false)).not.toContain('directory-email-everyone');
    // absent prop behaves like a plain member, not like an admin
    expect(render([row('Ada')])).not.toContain('Email everyone');
  });
});
